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
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinElevate.Helpers;
using Jellyfin.Plugin.JellyfinElevate.Model.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Helpers.Jellyseerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinElevate.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinElevate.Services.Jellyseerr;
using Jellyfin.Plugin.JellyfinElevate.Services;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Controllers
{
    /// <summary>
    /// Serves embedded plugin views.
    /// Split out of the former JellyfinElevateController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinElevate")]
    [ApiController]
    public class ViewsController : JellyfinElevateControllerBase
    {
        public ViewsController(
            IHttpClientFactory httpClientFactory,
            ILogger<ViewsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
        }

        // NOTE: greedy-looking catch-all kept as-is intentionally. ASP.NET Core gives
        // literal route segments precedence over the {viewName} parameter segment, so
        // this cannot shadow the other single-segment JellyfinElevate/* GET routes
        // (script, version, locales, public-config, ...) in the sibling controllers.
        [Authorize]
        [HttpGet("{viewName}")]
        public ActionResult GetView([FromRoute] string viewName)
        {
            if (JellyfinElevate.Instance == null)
            {
                return BadRequest("No plugin instance found");
            }

            IEnumerable<PluginPageInfo> pages = JellyfinElevate.Instance.GetViews();

            if (pages == null)
            {
                return NotFound("Pages is null or empty");
            }

            PluginPageInfo? view = pages.FirstOrDefault(pageInfo => pageInfo?.Name == viewName, null);

            if (view == null)
            {
                return NotFound("No matching view found");
            }

            Stream? stream = JellyfinElevate.Instance.GetType().Assembly.GetManifestResourceStream(view.EmbeddedResourcePath);

            if (stream == null)
            {
                _logger.LogWarning($"Failed to get resource {view.EmbeddedResourcePath}");
                return NotFound();
            }

            return File(stream, MimeTypes.GetMimeType(view.EmbeddedResourcePath));
        }
    }
}
