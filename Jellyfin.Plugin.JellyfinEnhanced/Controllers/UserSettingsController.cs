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
    /// Per-user settings CRUD (settings/shortcuts/elsewhere/bookmark) and reset-all-users-settings.
    /// Split out of the former JellyfinEnhancedController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinEnhanced")]
    [ApiController]
    public class UserSettingsController : JellyfinEnhancedControllerBase
    {
        private readonly UserConfigurationManager _userConfigurationManager;

        public UserSettingsController(
            IHttpClientFactory httpClientFactory,
            ILogger<UserSettingsController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            UserConfigurationManager userConfigurationManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userConfigurationManager = userConfigurationManager;
        }

        [HttpGet("user-settings/{userId}/settings.json")]
        [Authorize]
        public IActionResult GetUserSettingsSettings(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Populate defaults from plugin configuration if missing
            if (!_userConfigurationManager.UserConfigurationExists(authorizedUserId, "settings.json"))
            {
                var defaultConfig = _configProvider.ConfigurationOrNull;
                if (defaultConfig != null)
                {
                    var defaultUserSettings = new UserSettings
                    {
                        AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                        AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                        AutoPipEnabled = defaultConfig.AutoPipEnabled,
                        LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                        PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                        PauseScreenDelaySeconds = defaultConfig.PauseScreenDelaySeconds,
                        AutoSkipIntro = defaultConfig.AutoSkipIntro,
                        AutoSkipOutro = defaultConfig.AutoSkipOutro,
                        DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                        SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                        SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                        SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                        RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                        RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                        RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                        RandomIncludeShows = defaultConfig.RandomIncludeShows,
                        ShowWatchProgress = defaultConfig.ShowWatchProgress,
                        WatchProgressMode = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressDefaultMode) ? "percentage" : defaultConfig.WatchProgressDefaultMode,
                        WatchProgressTimeFormat = string.IsNullOrWhiteSpace(defaultConfig.WatchProgressTimeFormat) ? "hours" : defaultConfig.WatchProgressTimeFormat,
                        ShowFileSizes = defaultConfig.ShowFileSizes,
                        ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                        QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                        ShowResolutionTag = defaultConfig.ShowResolutionTag,
                        ShowSourceTag = defaultConfig.ShowSourceTag,
                        ShowDynamicRangeTag = defaultConfig.ShowDynamicRangeTag,
                        ShowSpecialFormatTag = defaultConfig.ShowSpecialFormatTag,
                        ShowVideoCodecTag = defaultConfig.ShowVideoCodecTag,
                        ShowAudioInfoTag = defaultConfig.ShowAudioInfoTag,
                        ResolutionTagOrder = defaultConfig.ResolutionTagOrder,
                        SourceTagOrder = defaultConfig.SourceTagOrder,
                        DynamicRangeTagOrder = defaultConfig.DynamicRangeTagOrder,
                        SpecialFormatTagOrder = defaultConfig.SpecialFormatTagOrder,
                        VideoCodecTagOrder = defaultConfig.VideoCodecTagOrder,
                        AudioInfoTagOrder = defaultConfig.AudioInfoTagOrder,
                        GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                        LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                        RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                        PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                        TagsHideOnHover = defaultConfig.TagsHideOnHover,
                        QualityTagsPosition = defaultConfig.QualityTagsPosition,
                        GenreTagsPosition = defaultConfig.GenreTagsPosition,
                        LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                        RatingTagsPosition = defaultConfig.RatingTagsPosition,
                        ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                        RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                        ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                        DisplayLanguage = defaultConfig.DefaultLanguage,
                        CalendarDisplayMode = "list",
                        CalendarDefaultViewMode = "agenda",
                        LastOpenedTab = "shortcuts"
                    };

                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "settings.json", defaultUserSettings);
                    _logger.LogInformation($"Saved default settings.json for new user {ResolveUserDisplay(authorizedUserId)} from plugin configuration.");
                }
            }

            var userConfig = _userConfigurationManager.GetUserConfiguration<UserSettings>(authorizedUserId, "settings.json");
            return Ok(userConfig);
        }

        [HttpGet("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        public IActionResult GetUserSettingsShortcuts(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var userConfig = _userConfigurationManager.GetUserConfiguration<UserShortcuts>(authorizedUserId, "shortcuts.json");
            return Ok(userConfig);
        }

        [HttpGet("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        public IActionResult GetUserSettingsElsewhere(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var userConfig = _userConfigurationManager.GetUserConfiguration<ElsewhereSettings>(authorizedUserId, "elsewhere.json");
            return Ok(userConfig);
        }

        [HttpPost("user-settings/{userId}/settings.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsSettings(string userId, [FromBody] UserSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                // Diff against the existing config so the log shows what actually changed
                var existing = _userConfigurationManager.GetUserConfiguration<UserSettings>(authorizedUserId, "settings.json");
                var changes = new System.Collections.Generic.List<string>();
                if (existing != null)
                {
                    var existingJson = System.Text.Json.JsonSerializer.Serialize(existing);
                    var newJson      = System.Text.Json.JsonSerializer.Serialize(userConfiguration);
                    if (existingJson != newJson)
                    {
                        var existingDoc = System.Text.Json.JsonDocument.Parse(existingJson).RootElement;
                        var newDoc      = System.Text.Json.JsonDocument.Parse(newJson).RootElement;
                        foreach (var prop in newDoc.EnumerateObject())
                        {
                            if (!existingDoc.TryGetProperty(prop.Name, out var oldVal) ||
                                oldVal.ToString() != prop.Value.ToString())
                            {
                                changes.Add($"{prop.Name}: {(existingDoc.TryGetProperty(prop.Name, out var ov) ? ov.ToString() : "—")} → {prop.Value}");
                            }
                        }
                    }
                }

                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "settings.json", userConfiguration);

                if (changes.Count > 0)
                    _logger.LogInformation($"Saved user settings for {ResolveUserDisplay(authorizedUserId)}: {string.Join(", ", changes)}");

                return Ok(new { success = true, file = "settings.json" });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save user settings for user {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user settings." });
            }
        }

        [HttpPost("user-settings/{userId}/shortcuts.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsShortcuts(string userId, [FromBody] UserShortcuts userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "shortcuts.json", userConfiguration);
                _logger.LogInformation($"Saved user shortcuts for {ResolveUserDisplay(authorizedUserId)} to shortcuts.json");
                return Ok(new { success = true, file = "shortcuts.json" });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save user shortcuts for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user shortcuts." });
            }
        }

        [HttpGet("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserBookmark(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            var userConfig = _userConfigurationManager.GetUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json");
            return Ok(userConfig);
        }

        [HttpPost("user-settings/{userId}/bookmark.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserBookmark(string userId, [FromBody] UserBookmark userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "bookmark.json", userConfiguration);
                _logger.LogInformation($"Saved enhanced bookmarks for {ResolveUserDisplay(authorizedUserId)} to bookmark.json");
                return Ok(new { success = true, file = "bookmark.json" });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save enhanced bookmarks for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save enhanced bookmarks." });
            }
        }

        public sealed class AddBookmarkPayload
        {
            public string ItemId { get; set; } = string.Empty;
            public string TmdbId { get; set; } = string.Empty;
            public string TvdbId { get; set; } = string.Empty;
            public string MediaType { get; set; } = string.Empty;
            public string Name { get; set; } = string.Empty;
            public double Timestamp { get; set; }
            public string Label { get; set; } = string.Empty;
            public string SyncedFrom { get; set; } = string.Empty;
        }

        [HttpPost("user-settings/{userId}/bookmark.json/add")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AddUserBookmark(string userId, [FromBody] AddBookmarkPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || string.IsNullOrWhiteSpace(payload.ItemId))
            {
                return BadRequest(new { success = false, message = "ItemId is required." });
            }

            var now = DateTime.UtcNow.ToString("o");
            var bookmarkId = $"Bm_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N").Substring(0, 9)}";

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json", config =>
                {
                    config.Bookmarks[bookmarkId] = new BookmarkItem
                    {
                        ItemId = payload.ItemId,
                        TmdbId = payload.TmdbId ?? string.Empty,
                        TvdbId = payload.TvdbId ?? string.Empty,
                        MediaType = payload.MediaType ?? string.Empty,
                        Name = payload.Name ?? string.Empty,
                        Timestamp = payload.Timestamp,
                        Label = payload.Label ?? string.Empty,
                        CreatedAt = now,
                        UpdatedAt = now,
                        SyncedFrom = payload.SyncedFrom ?? string.Empty
                    };
                    return 1;
                });
                _logger.LogInformation($"Added bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)}");
                return Ok(new { success = true, id = bookmarkId });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to add bookmark for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to add bookmark." });
            }
        }

        [HttpDelete("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult RemoveUserBookmark(string userId, string bookmarkId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (string.IsNullOrWhiteSpace(bookmarkId))
            {
                return BadRequest(new { success = false, message = "bookmarkId is required." });
            }

            try
            {
                var removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserBookmark>(authorizedUserId, "bookmark.json", config =>
                {
                    removed = config.Bookmarks.Remove(bookmarkId);
                    return removed ? 1 : 0;
                });

                if (!removed)
                {
                    return NotFound(new { success = false, removed = false, message = "No matching bookmark to remove." });
                }

                _logger.LogInformation($"Removed bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)}");
                return Ok(new { success = true, removed = true });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to remove bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to remove bookmark." });
            }
        }

        [HttpPost("user-settings/{userId}/elsewhere.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult SaveUserSettingsElsewhere(string userId, [FromBody] ElsewhereSettings userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            try
            {
                _userConfigurationManager.SaveUserConfiguration(authorizedUserId, "elsewhere.json", userConfiguration);
                _logger.LogInformation($"Saved user elsewhere settings for {ResolveUserDisplay(authorizedUserId)} to elsewhere.json");
                return Ok(new { success = true, file = "elsewhere.json" });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save user elsewhere settings for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user elsewhere settings." });
            }
        }

        [HttpPost("reset-all-users-settings")]
        [Authorize]
        public IActionResult ResetAllUsersSettings()
        {
            if (!IsAdminUser())
            {
                return Forbid();
            }

            var defaultConfig = _configProvider.ConfigurationOrNull;

            if (defaultConfig == null)
            {
                return StatusCode(500, new { success = false, message = "Default plugin configuration not found." });
            }

            var defaultUserSettings = new UserSettings
            {
                AutoPauseEnabled = defaultConfig.AutoPauseEnabled,
                AutoResumeEnabled = defaultConfig.AutoResumeEnabled,
                AutoPipEnabled = defaultConfig.AutoPipEnabled,
                LongPress2xEnabled = defaultConfig.LongPress2xEnabled,
                PauseScreenEnabled = defaultConfig.PauseScreenEnabled,
                PauseScreenDelaySeconds = defaultConfig.PauseScreenDelaySeconds,
                AutoSkipIntro = defaultConfig.AutoSkipIntro,
                AutoSkipOutro = defaultConfig.AutoSkipOutro,
                DisableCustomSubtitleStyles = defaultConfig.DisableCustomSubtitleStyles,
                SelectedStylePresetIndex = defaultConfig.DefaultSubtitleStyle,
                SelectedFontSizePresetIndex = defaultConfig.DefaultSubtitleSize,
                SelectedFontFamilyPresetIndex = defaultConfig.DefaultSubtitleFont,
                RandomButtonEnabled = defaultConfig.RandomButtonEnabled,
                RandomUnwatchedOnly = defaultConfig.RandomUnwatchedOnly,
                RandomIncludeMovies = defaultConfig.RandomIncludeMovies,
                RandomIncludeShows = defaultConfig.RandomIncludeShows,
                ShowWatchProgress = defaultConfig.ShowWatchProgress,
                ShowFileSizes = defaultConfig.ShowFileSizes,
                ShowAudioLanguages = defaultConfig.ShowAudioLanguages,
                QualityTagsEnabled = defaultConfig.QualityTagsEnabled,
                ShowResolutionTag = defaultConfig.ShowResolutionTag,
                ShowSourceTag = defaultConfig.ShowSourceTag,
                ShowDynamicRangeTag = defaultConfig.ShowDynamicRangeTag,
                ShowSpecialFormatTag = defaultConfig.ShowSpecialFormatTag,
                ShowVideoCodecTag = defaultConfig.ShowVideoCodecTag,
                ShowAudioInfoTag = defaultConfig.ShowAudioInfoTag,
                ResolutionTagOrder = defaultConfig.ResolutionTagOrder,
                SourceTagOrder = defaultConfig.SourceTagOrder,
                DynamicRangeTagOrder = defaultConfig.DynamicRangeTagOrder,
                SpecialFormatTagOrder = defaultConfig.SpecialFormatTagOrder,
                VideoCodecTagOrder = defaultConfig.VideoCodecTagOrder,
                AudioInfoTagOrder = defaultConfig.AudioInfoTagOrder,
                GenreTagsEnabled = defaultConfig.GenreTagsEnabled,
                LanguageTagsEnabled = defaultConfig.LanguageTagsEnabled,
                RatingTagsEnabled = defaultConfig.RatingTagsEnabled,
                PeopleTagsEnabled = defaultConfig.PeopleTagsEnabled,
                QualityTagsPosition = defaultConfig.QualityTagsPosition,
                GenreTagsPosition = defaultConfig.GenreTagsPosition,
                LanguageTagsPosition = defaultConfig.LanguageTagsPosition,
                RatingTagsPosition = defaultConfig.RatingTagsPosition,
                ShowRatingInPlayer = defaultConfig.ShowRatingInPlayer,
                RemoveContinueWatchingEnabled = defaultConfig.RemoveContinueWatchingEnabled,
                ReviewsExpandedByDefault = defaultConfig.ReviewsExpandedByDefault,
                DisplayLanguage = defaultConfig.DefaultLanguage,
                CalendarDisplayMode = "list",
                CalendarDefaultViewMode = "agenda",
                LastOpenedTab = "shortcuts"
            };

            var userCount = 0;
            var skippedSettings = new System.Collections.Generic.List<string>();
            var skippedHc = new System.Collections.Generic.List<string>();
            // Get all user IDs from the UserConfigurationManager's known users
            var userIds = _userConfigurationManager.GetAllUserIds();
            foreach (var userId in userIds)
            {
                try
                {
                    _userConfigurationManager.SaveUserConfiguration(userId, "settings.json", defaultUserSettings);
                    userCount++;
                }
                catch (Exception ex)
                {
                    _logger.LogWarning($"Skipping settings.json reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedSettings.Add(userId);
                }

                // Push HC Settings only — user's Items dict is data, not a default. Per-user errors are skipped, not fatal.
                try
                {
                    _userConfigurationManager.RmwUserConfiguration<UserHiddenContent>(
                        userId, "hidden-content.json", hc =>
                        {
                            hc.Settings = BuildHcDefaultSettings(defaultConfig);
                            return 1;
                        });
                    Services.HiddenContentResponseFilter.InvalidateUser(userId);
                }
                catch (Exception ex) when (ex is InvalidDataException
                                        || ex is System.Text.Json.JsonException
                                        || ex is IOException
                                        || ex is UnauthorizedAccessException)
                {
                    _logger.LogWarning($"Skipping HC settings reset for {ResolveUserDisplay(userId)}: {ex.Message}");
                    skippedHc.Add(userId);
                }
            }

            _logger.LogInformation($"Reset settings for {userCount}/{userIds.Count()} users to plugin defaults. Skipped settings: {skippedSettings.Count}, skipped HC: {skippedHc.Count}.");
            return Ok(new
            {
                success = true,
                userCount,
                totalUsers = userIds.Count(),
                skippedSettingsUserIds = skippedSettings,
                skippedHcUserIds = skippedHc,
            });
        }
    }
}
