using Microsoft.AspNetCore.Mvc;
using System;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.StaticFiles;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinEnhanced.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinEnhanced.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinEnhanced.Controllers
{
    /// <summary>
    /// Branding image upload/get/delete.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class BrandingController : JellyfinEnhancedControllerBase
    {
        public BrandingController(
            IHttpClientFactory httpClientFactory,
            ILogger<BrandingController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
        }

        private static readonly HashSet<string> BrandingFileNames = new(new[]
        {
            "icon-transparent.png",
            "banner-light.png",
            "banner-dark.png",
            "favicon.ico",
            "apple-touch-icon.png"
        }, StringComparer.OrdinalIgnoreCase);

        private bool TryResolveBrandingFilePath(string requestedFileName, out string normalizedFileName, out string filePath)
        {
            normalizedFileName = Path.GetFileName(requestedFileName ?? string.Empty);
            filePath = string.Empty;

            if (string.IsNullOrWhiteSpace(normalizedFileName) || !BrandingFileNames.Contains(normalizedFileName))
            {
                return false;
            }

            var brandingDir = JellyfinEnhanced.BrandingDirectory;
            if (string.IsNullOrWhiteSpace(brandingDir))
            {
                return false;
            }

            var fullBrandingDir = Path.GetFullPath(brandingDir);
            var candidateFilePath = Path.GetFullPath(Path.Combine(fullBrandingDir, normalizedFileName));
            var candidateDirectory = Path.GetDirectoryName(candidateFilePath);

            if (!string.Equals(candidateDirectory, fullBrandingDir, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            filePath = candidateFilePath;
            return true;
        }

        [HttpPost("UploadBrandingImage")]
        [Authorize]
        public async Task<IActionResult> UploadBrandingImage()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                if (Request.Form.Files.Count == 0)
                    return BadRequest("No file uploaded");

                var uploadedFile = Request.Form.Files[0];

                // Get fileName from form data
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }

                if (!TryResolveBrandingFilePath(fileName, out var normalizedFileName, out var filePath))
                {
                    return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
                }

                // Validate file type - accept only image files
                if (!uploadedFile.ContentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                    return BadRequest("Only image files are allowed");

                const long maxFileSize = 10 * 1024 * 1024; // 10MB
                if (uploadedFile.Length > maxFileSize)
                    return BadRequest($"File too large (max 10MB)");

                // Get branding directory from central location
                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                Directory.CreateDirectory(brandingDir);

                // Save file
                using (var stream = new FileStream(filePath, FileMode.Create, FileAccess.Write))
                {
                    await uploadedFile.CopyToAsync(stream);
                }

                _logger.LogInformation($"Successfully uploaded branding image: {normalizedFileName} ({uploadedFile.Length} bytes) to {brandingDir}");
                return Ok("File uploaded successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.LogError($"Permission denied when uploading branding image: {ex.Message}");
                return StatusCode(403, "Permission denied when uploading branding image.");
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error uploading branding image: {ex.Message}");
                return StatusCode(500, "An error occurred while uploading the branding image.");
            }
        }

        [HttpGet("BrandingImage")]
        [Authorize]
        public IActionResult GetBrandingImage([FromQuery] string? fileName)
        {
            if (string.IsNullOrWhiteSpace(fileName))
            {
                return BadRequest("fileName query parameter is required");
            }

            if (!TryResolveBrandingFilePath(fileName, out _, out var filePath))
            {
                return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
            }

            if (!System.IO.File.Exists(filePath))
                return NotFound();

            var provider = new FileExtensionContentTypeProvider();
            if (!provider.TryGetContentType(filePath, out var contentType))
            {
                contentType = "application/octet-stream";
            }

            return PhysicalFile(filePath, contentType);
        }

        [HttpPost("DeleteBrandingImage")]
        [Authorize]
        public IActionResult DeleteBrandingImage()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            try
            {
                string? fileName = Request.Form["fileName"].FirstOrDefault();
                if (string.IsNullOrWhiteSpace(fileName))
                {
                    return BadRequest("fileName parameter is required in form data");
                }

                if (!TryResolveBrandingFilePath(fileName, out var normalizedFileName, out var filePath))
                {
                    return BadRequest($"fileName must be one of: {string.Join(", ", BrandingFileNames)}");
                }

                var brandingDir = JellyfinEnhanced.BrandingDirectory;
                if (string.IsNullOrWhiteSpace(brandingDir))
                    return StatusCode(500, "Could not determine branding directory");

                if (!System.IO.File.Exists(filePath))
                    return NotFound("File not found");

                System.IO.File.Delete(filePath);
                _logger.LogInformation($"Deleted branding image: {normalizedFileName} from {brandingDir}");
                return Ok("File deleted successfully");
            }
            catch (UnauthorizedAccessException ex)
            {
                _logger.LogError($"Permission denied when deleting branding image: {ex.Message}");
                return StatusCode(403, "Permission denied when deleting branding image.");
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error deleting branding image: {ex.Message}");
                return StatusCode(500, "An error occurred while deleting the branding image.");
            }
        }
    }
}
