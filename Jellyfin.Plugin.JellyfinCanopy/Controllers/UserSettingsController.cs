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
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model;
using MediaBrowser.Controller.Persistence;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Enums;
using Microsoft.EntityFrameworkCore;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.Extensions.Logging;
using MediaBrowser.Common.Api;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Per-user settings CRUD (settings/shortcuts/elsewhere/bookmark) and reset-all-users-settings.
    /// Split out of the former JellyfinCanopyController; method bodies, routes
    /// and attributes are unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class UserSettingsController : JellyfinCanopyControllerBase
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

            var read = _userConfigurationManager.ReadUserConfiguration<UserBookmark>(authorizedUserId, BookmarkFileName);
            if (!read.HasUsableValue || read.Value == null || !IsValidBookmarkState(read.Value))
            {
                _logger.LogWarning(
                    $"Refusing to publish unavailable bookmark state for {ResolveUserDisplay(authorizedUserId)} " +
                    $"(status={read.Status}, detail={read.FaultDetail ?? "invalid-state"}).");
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Bookmark state is unavailable. No empty replacement state was published."
                });
            }

            SetBookmarkEtag(read.Value.Revision);
            return Ok(read.Value);
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

            if (userConfiguration == null || userConfiguration.Bookmarks == null)
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = "Bookmarks is required." });
            }

            if (!TryParseIfMatchRevision(out var expectedRevision))
            {
                return StatusCode(StatusCodes.Status428PreconditionRequired, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Full bookmark replacement requires If-Match: \"<revision>\" from the latest GET."
                });
            }

            if (userConfiguration.Revision != expectedRevision)
            {
                return BadRequest(new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "The body Revision must match the If-Match revision."
                });
            }

            try
            {
                var result = CommitBookmarkMutation(authorizedUserId, expectedRevision, current =>
                {
                    var replacement = new Dictionary<string, BookmarkItem>(StringComparer.Ordinal);
                    foreach (var pair in userConfiguration.Bookmarks)
                    {
                        if (!IsValidBookmarkId(pair.Key) || !IsValidBookmarkItem(pair.Value))
                        {
                            return BookmarkMutationPlan.Invalid(BookmarkInputMessage);
                        }

                        replacement[pair.Key] = CloneBookmark(pair.Value);
                    }

                    current.Bookmarks = replacement;
                    return BookmarkMutationPlan.Change();
                });
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    _logger.LogInformation($"Replaced enhanced bookmarks for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "replace bookmarks", ex);
            }
        }

        public sealed class AddBookmarkPayload
        {
            public long? Revision { get; set; }
            public string BookmarkId { get; set; } = string.Empty;
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

            if (!payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            var now = DateTime.UtcNow.ToString("o");
            var bookmarkId = string.IsNullOrWhiteSpace(payload.BookmarkId)
                ? $"Bm_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid().ToString("N").Substring(0, 9)}"
                : payload.BookmarkId;

            if (!IsValidBookmarkId(bookmarkId))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
            }

            try
            {
                var item = new BookmarkItem
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
                if (!IsValidBookmarkItem(item))
                {
                    return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
                }
                var result = CommitBookmarkMutation(authorizedUserId, payload.Revision, current =>
                    ApplyBookmarkOperations(current, new[]
                    {
                        new BookmarkOperationPayload { Type = "add", BookmarkId = bookmarkId, Bookmark = item }
                    }));
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    result.ResponseId = bookmarkId;
                    _logger.LogInformation($"Added bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "add bookmark", ex);
            }
        }

        public sealed class UpdateBookmarkPayload
        {
            public long? Revision { get; set; }
            public BookmarkItem? Bookmark { get; set; }
        }

        [HttpPut("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult UpdateUserBookmark(string userId, string bookmarkId, [FromBody] UpdateBookmarkPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || !IsValidBookmarkItem(payload.Bookmark) || !IsValidBookmarkId(bookmarkId))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
            }

            if (!payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            try
            {
                var result = CommitBookmarkMutation(authorizedUserId, payload.Revision, current =>
                    ApplyBookmarkOperations(current, new[]
                    {
                        new BookmarkOperationPayload { Type = "update", BookmarkId = bookmarkId, Bookmark = payload.Bookmark }
                    }));
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    result.ResponseId = bookmarkId;
                    _logger.LogInformation($"Updated bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "update bookmark", ex);
            }
        }

        [HttpDelete("user-settings/{userId}/bookmark.json/{bookmarkId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult RemoveUserBookmark(string userId, string bookmarkId, [FromQuery] long? revision)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (!IsValidBookmarkId(bookmarkId))
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = BookmarkInputMessage });
            }

            if (!revision.HasValue)
            {
                return PreconditionRequired();
            }

            try
            {
                var result = CommitBookmarkMutation(authorizedUserId, revision, current =>
                {
                    if (!current.Bookmarks.ContainsKey(bookmarkId))
                    {
                        return BookmarkMutationPlan.Missing("No matching bookmark to remove.");
                    }
                    return ApplyBookmarkOperations(current, new[]
                    {
                        new BookmarkOperationPayload { Type = "delete", BookmarkId = bookmarkId }
                    });
                });
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    result.Removed = true;
                    _logger.LogInformation($"Removed bookmark {bookmarkId} for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "remove bookmark", ex);
            }
        }

        public sealed class BookmarkBatchPayload
        {
            public long? Revision { get; set; }
            public List<BookmarkOperationPayload> Operations { get; set; } = new List<BookmarkOperationPayload>();
        }

        public sealed class BookmarkOperationPayload
        {
            public string Type { get; set; } = string.Empty;
            public string BookmarkId { get; set; } = string.Empty;
            public BookmarkItem? Bookmark { get; set; }
        }

        public sealed class BookmarkMutationResponse
        {
            public bool Success { get; set; }
            public bool Conflict { get; set; }
            public string Message { get; set; } = string.Empty;
            public string Id { get; set; } = string.Empty;
            public bool? Removed { get; set; }
            public long Revision { get; set; }
            public Dictionary<string, BookmarkItem> Bookmarks { get; set; } = new Dictionary<string, BookmarkItem>();
        }

        [HttpPost("user-settings/{userId}/bookmark.json/batch")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult BatchUserBookmarks(string userId, [FromBody] BookmarkBatchPayload payload)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (payload == null || payload.Operations == null || payload.Operations.Count == 0)
            {
                return BadRequest(new BookmarkMutationResponse { Success = false, Message = "At least one operation is required." });
            }

            if (payload.Operations.Count > 1000)
            {
                return StatusCode(StatusCodes.Status413PayloadTooLarge, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "A bookmark batch may contain at most 1000 operations."
                });
            }

            if (!payload.Revision.HasValue)
            {
                return PreconditionRequired();
            }

            try
            {
                var result = CommitBookmarkMutation(authorizedUserId, payload.Revision, current =>
                    ApplyBookmarkOperations(current, payload.Operations));
                if (result.Status == BookmarkCommitStatus.Success)
                {
                    _logger.LogInformation(
                        $"Committed {payload.Operations.Count} bookmark operations for {ResolveUserDisplay(authorizedUserId)} at revision {result.State!.Revision}");
                }
                return ToBookmarkActionResult(result);
            }
            catch (Exception ex)
            {
                return BookmarkWriteFailure(authorizedUserId, "apply bookmark batch", ex);
            }
        }

        private const string BookmarkFileName = "bookmark.json";
        private const int MaxBookmarkIdLength = 256;
        private const int MaxBookmarkStringLength = 4096;
        private const string BookmarkInputMessage = "Bookmark ids must be 1-256 characters; ItemId is required; bookmark strings are capped at 4096 characters; Timestamp must be finite and non-negative.";

        private enum BookmarkCommitStatus
        {
            Success,
            PreconditionRequired,
            Conflict,
            Invalid,
            NotFound
        }

        private sealed class BookmarkCommitResult
        {
            public BookmarkCommitStatus Status { get; set; }
            public UserBookmark? State { get; set; }
            public string Message { get; set; } = string.Empty;
            public string ResponseId { get; set; } = string.Empty;
            public bool? Removed { get; set; }
        }

        private sealed class BookmarkMutationPlan
        {
            public BookmarkCommitStatus Status { get; private set; } = BookmarkCommitStatus.Success;
            public bool Changed { get; private set; }
            public string Message { get; private set; } = string.Empty;

            public static BookmarkMutationPlan Change() => new BookmarkMutationPlan { Changed = true };
            public static BookmarkMutationPlan NoChange() => new BookmarkMutationPlan();
            public static BookmarkMutationPlan Invalid(string message) => new BookmarkMutationPlan { Status = BookmarkCommitStatus.Invalid, Message = message };
            public static BookmarkMutationPlan Missing(string message) => new BookmarkMutationPlan { Status = BookmarkCommitStatus.NotFound, Message = message };
            public static BookmarkMutationPlan Conflict(string message) => new BookmarkMutationPlan { Status = BookmarkCommitStatus.Conflict, Message = message };
        }

        private BookmarkCommitResult CommitBookmarkMutation(
            string authorizedUserId,
            long? expectedRevision,
            Func<UserBookmark, BookmarkMutationPlan> mutate)
        {
            lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, BookmarkFileName))
            {
                var current = _userConfigurationManager.GetUserConfigurationStrict<UserBookmark>(authorizedUserId, BookmarkFileName);
                if (!IsValidBookmarkState(current))
                {
                    throw new InvalidDataException("Bookmark state has an invalid revision or bookmark map.");
                }

                if (!expectedRevision.HasValue)
                {
                    return new BookmarkCommitResult
                    {
                        Status = BookmarkCommitStatus.PreconditionRequired,
                        State = current,
                        Message = "A bookmark revision precondition is required."
                    };
                }

                if (expectedRevision.Value != current.Revision)
                {
                    return new BookmarkCommitResult
                    {
                        Status = BookmarkCommitStatus.Conflict,
                        State = current,
                        Message = "Bookmark state changed. Rebase the operation on the returned revision/state and retry."
                    };
                }

                var plan = mutate(current);
                if (plan.Status != BookmarkCommitStatus.Success)
                {
                    return new BookmarkCommitResult { Status = plan.Status, State = current, Message = plan.Message };
                }

                if (plan.Changed)
                {
                    current.Revision = checked(current.Revision + 1);
                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, BookmarkFileName, current);
                }

                return new BookmarkCommitResult { Status = BookmarkCommitStatus.Success, State = current };
            }
        }

        private static BookmarkMutationPlan ApplyBookmarkOperations(
            UserBookmark current,
            IReadOnlyCollection<BookmarkOperationPayload> operations)
        {
            var working = current.Bookmarks.ToDictionary(
                pair => pair.Key,
                pair => CloneBookmark(pair.Value),
                StringComparer.Ordinal);
            var changed = false;

            foreach (var operation in operations)
            {
                if (operation == null || !IsValidBookmarkId(operation.BookmarkId))
                {
                    return BookmarkMutationPlan.Invalid(BookmarkInputMessage);
                }

                switch ((operation.Type ?? string.Empty).Trim().ToLowerInvariant())
                {
                    case "add":
                        if (!IsValidBookmarkItem(operation.Bookmark))
                        {
                            return BookmarkMutationPlan.Invalid(BookmarkInputMessage);
                        }

                        var added = CloneBookmark(operation.Bookmark!);
                        if (working.TryGetValue(operation.BookmarkId, out var existing))
                        {
                            if (!BookmarkEquals(existing, added))
                            {
                                return BookmarkMutationPlan.Conflict($"Bookmark id '{operation.BookmarkId}' already exists with different data.");
                            }
                            break;
                        }

                        working[operation.BookmarkId] = added;
                        changed = true;
                        break;

                    case "update":
                        if (!IsValidBookmarkItem(operation.Bookmark))
                        {
                            return BookmarkMutationPlan.Invalid(BookmarkInputMessage);
                        }
                        if (!working.TryGetValue(operation.BookmarkId, out var oldBookmark))
                        {
                            return BookmarkMutationPlan.Missing($"Bookmark id '{operation.BookmarkId}' does not exist.");
                        }

                        var updated = CloneBookmark(operation.Bookmark!);
                        if (string.IsNullOrWhiteSpace(updated.CreatedAt)) updated.CreatedAt = oldBookmark.CreatedAt;
                        if (!BookmarkEquals(oldBookmark, updated))
                        {
                            working[operation.BookmarkId] = updated;
                            changed = true;
                        }
                        break;

                    case "delete":
                        changed |= working.Remove(operation.BookmarkId);
                        break;

                    default:
                        return BookmarkMutationPlan.Invalid($"Unsupported bookmark operation type '{operation.Type}'.");
                }
            }

            if (!changed)
            {
                return BookmarkMutationPlan.NoChange();
            }

            current.Bookmarks = working;
            return BookmarkMutationPlan.Change();
        }

        private static BookmarkItem CloneBookmark(BookmarkItem source)
            => new BookmarkItem
            {
                ItemId = source.ItemId ?? string.Empty,
                TmdbId = source.TmdbId ?? string.Empty,
                TvdbId = source.TvdbId ?? string.Empty,
                MediaType = source.MediaType ?? string.Empty,
                Name = source.Name ?? string.Empty,
                Timestamp = source.Timestamp,
                Label = source.Label ?? string.Empty,
                CreatedAt = source.CreatedAt ?? string.Empty,
                UpdatedAt = source.UpdatedAt ?? string.Empty,
                SyncedFrom = source.SyncedFrom ?? string.Empty
            };

        private static bool BookmarkEquals(BookmarkItem left, BookmarkItem right)
            => string.Equals(left.ItemId, right.ItemId, StringComparison.Ordinal)
            && string.Equals(left.TmdbId, right.TmdbId, StringComparison.Ordinal)
            && string.Equals(left.TvdbId, right.TvdbId, StringComparison.Ordinal)
            && string.Equals(left.MediaType, right.MediaType, StringComparison.Ordinal)
            && string.Equals(left.Name, right.Name, StringComparison.Ordinal)
            && left.Timestamp.Equals(right.Timestamp)
            && string.Equals(left.Label, right.Label, StringComparison.Ordinal)
            && string.Equals(left.CreatedAt, right.CreatedAt, StringComparison.Ordinal)
            && string.Equals(left.UpdatedAt, right.UpdatedAt, StringComparison.Ordinal)
            && string.Equals(left.SyncedFrom, right.SyncedFrom, StringComparison.Ordinal);

        private static bool IsValidBookmarkState(UserBookmark state)
            => state.Revision >= 0 && state.Bookmarks != null;

        private static bool IsValidBookmarkId(string? bookmarkId)
            => !string.IsNullOrWhiteSpace(bookmarkId) && bookmarkId.Length <= MaxBookmarkIdLength;

        private static bool IsValidBookmarkItem(BookmarkItem? bookmark)
            => bookmark != null
            && !string.IsNullOrWhiteSpace(bookmark.ItemId)
            && bookmark.ItemId.Length <= MaxBookmarkStringLength
            && (bookmark.TmdbId?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.TvdbId?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.MediaType?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.Name?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.Label?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.CreatedAt?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.UpdatedAt?.Length ?? 0) <= MaxBookmarkStringLength
            && (bookmark.SyncedFrom?.Length ?? 0) <= MaxBookmarkStringLength
            && double.IsFinite(bookmark.Timestamp)
            && bookmark.Timestamp >= 0;

        private bool TryParseIfMatchRevision(out long revision)
        {
            revision = -1;
            var raw = Request.Headers["If-Match"].ToString().Trim();
            if (raw.StartsWith("W/", StringComparison.OrdinalIgnoreCase)) return false;
            if (raw.Length < 2 || raw[0] != '"' || raw[^1] != '"') return false;
            raw = raw.Substring(1, raw.Length - 2);
            return long.TryParse(raw, out revision) && revision >= 0;
        }

        private IActionResult PreconditionRequired()
            => StatusCode(StatusCodes.Status428PreconditionRequired, new BookmarkMutationResponse
            {
                Success = false,
                Message = "A bookmark Revision from the latest committed state is required."
            });

        private IActionResult ToBookmarkActionResult(BookmarkCommitResult result)
        {
            if (result.State != null) SetBookmarkEtag(result.State.Revision);
            var response = new BookmarkMutationResponse
            {
                Success = result.Status == BookmarkCommitStatus.Success,
                Conflict = result.Status == BookmarkCommitStatus.Conflict,
                Message = result.Message,
                Id = result.ResponseId,
                Removed = result.Removed,
                Revision = result.State?.Revision ?? 0,
                Bookmarks = result.State?.Bookmarks ?? new Dictionary<string, BookmarkItem>()
            };

            return result.Status switch
            {
                BookmarkCommitStatus.Success => Ok(response),
                BookmarkCommitStatus.PreconditionRequired => StatusCode(StatusCodes.Status428PreconditionRequired, response),
                BookmarkCommitStatus.Conflict => Conflict(response),
                BookmarkCommitStatus.Invalid => BadRequest(response),
                BookmarkCommitStatus.NotFound => NotFound(response),
                _ => StatusCode(StatusCodes.Status500InternalServerError, response)
            };
        }

        private IActionResult BookmarkWriteFailure(string authorizedUserId, string operation, Exception ex)
        {
            _logger.LogError($"Failed to {operation} for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
            if (ex is InvalidDataException || ex is JsonException || ex is IOException || ex is UnauthorizedAccessException)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new BookmarkMutationResponse
                {
                    Success = false,
                    Message = "Bookmark state is corrupt or temporarily unavailable; no mutation was committed."
                });
            }

            return StatusCode(StatusCodes.Status500InternalServerError, new BookmarkMutationResponse
            {
                Success = false,
                Message = "Bookmark mutation failed; no state was acknowledged."
            });
        }

        private void SetBookmarkEtag(long revision)
            => Response.Headers.ETag = $"\"{revision}\"";

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
        [Authorize(Policy = Policies.RequiresElevation)]
        public IActionResult ResetAllUsersSettings()
        {
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
