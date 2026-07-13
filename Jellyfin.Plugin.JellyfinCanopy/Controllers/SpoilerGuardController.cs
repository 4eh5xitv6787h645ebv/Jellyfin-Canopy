using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Owns every Spoiler Guard HTTP endpoint: the self-or-admin spoilerblur.json
    /// accessor pair, the corruption-health surface, the per-series / per-movie /
    /// per-collection opt-in toggles, the per-user strip-override prefs and the
    /// pre-acquisition (Seerr / not-yet-downloaded) pending flow. All per-user state
    /// lives in spoilerblur.json; the promoter's static gate is reconciled on every
    /// pending-affecting write. Split out of the monolithic controller; routes are
    /// identical to the reference so the client is unchanged.
    /// </summary>
    [Route("JellyfinCanopy")]
    [ApiController]
    public class SpoilerGuardController : JellyfinCanopyControllerBase
    {
        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly ILibraryManager _libraryManager;
        private readonly SpoilerPendingService _pendingService;
        private readonly SpoilerUserResolver _resolver;
        private readonly IUserDataManager _userDataManager;

        public SpoilerGuardController(
            IHttpClientFactory httpClientFactory,
            ILogger<SpoilerGuardController> logger,
            IUserManager userManager,
            ISeerrCache seerrCache,
            IPluginConfigProvider configProvider,
            UserConfigurationManager userConfigurationManager,
            ILibraryManager libraryManager,
            SpoilerPendingService pendingService,
            SpoilerUserResolver resolver,
            IUserDataManager userDataManager)
            : base(httpClientFactory, logger, userManager, seerrCache, configProvider)
        {
            _userConfigurationManager = userConfigurationManager;
            _libraryManager = libraryManager;
            _pendingService = pendingService;
            _resolver = resolver;
            _userDataManager = userDataManager;
        }

        private const string SpoilerFileName = "spoilerblur.json";

        // Standard corrupt-store response: log, record the corruption event (so the
        // health endpoint / management banner can surface it), and 503.
        private IActionResult CorruptStore(string userKey, Exception strictEx)
        {
            _logger.LogWarning($"{SpoilerFileName} corrupt for {ResolveUserDisplay(userKey)} (backed up): {strictEx.Message}");
            SpoilerUserResolver.RecordCorruption(userKey, ResolveUserDisplay(userKey), strictEx.Message);
            return StatusCode(503, new { success = false, message = "Spoiler Guard data was corrupt and has been backed up. Your stored values have been reset to defaults — please reconfigure." });
        }

        // ─── Self-or-admin spoilerblur.json accessor pair ───────────────────────
        // Mirrors the other per-user JC files so an administrator can inspect or
        // repair a user's Spoiler Guard state remotely.

        [HttpGet("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetUserSpoilerBlur(string userId)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            // Lenient read on purpose: this is an inspection surface, so a corrupt
            // file should still return the (empty) default rather than 503 — the
            // user-facing spoiler-blur endpoints already handle strict reads,
            // backups and corruption reporting.
            var state = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(
                authorizedUserId, SpoilerFileName);
            return Ok(state);
        }

        // Hard cap per spoiler-list dict on the raw full-state save endpoint: the
        // image/field-strip filters iterate this file every request (a Collections
        // key drives a library lookup per key), so an unbounded payload amplifies
        // into millions of lookups per library view. Mirrors the pending path cap.
        private const int MaxSpoilerEntriesPerDict = 1000;

        [HttpPost("user-settings/{userId}/spoilerblur.json")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        // Cap the body: 4×1000 entries is a few hundred KB even with long names.
        // 2 MB leaves headroom while removing Kestrel's ~28 MB default as a DoS lever.
        [RequestSizeLimit(2 * 1024 * 1024)]
        public IActionResult SaveUserSpoilerBlur(string userId, [FromBody] UserSpoilerBlur userConfiguration)
        {
            var authorizationResult = AuthorizeUserConfigAccess(userId, out var authorizedUserId);
            if (authorizationResult != null)
            {
                return authorizationResult;
            }

            if (userConfiguration == null)
            {
                return BadRequest(new { success = false, message = "Invalid Spoiler Guard payload." });
            }

            // Reject oversized payloads rather than silently truncating — dropping
            // entries would confuse a legitimate large list, and over-cap is buggy or hostile.
            if (userConfiguration.Series.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Movies.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.Collections.Count > MaxSpoilerEntriesPerDict
                || userConfiguration.PendingTmdb.Count > MaxSpoilerEntriesPerDict)
            {
                _logger.LogWarning($"Rejecting oversized Spoiler Guard payload for {ResolveUserDisplay(authorizedUserId)} (series={userConfiguration.Series.Count}, movies={userConfiguration.Movies.Count}, collections={userConfiguration.Collections.Count}, pending={userConfiguration.PendingTmdb.Count}; cap {MaxSpoilerEntriesPerDict}).");
                return StatusCode(413, new { success = false, message = $"Spoiler Guard list exceeds the maximum of {MaxSpoilerEntriesPerDict} entries per category." });
            }

            // Snapshot pre-write pending keys to diff the promoter gate after save:
            // this endpoint is a pending writer too and must keep the gate in sync.
            HashSet<string> priorPending;
            try
            {
                var prior = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(authorizedUserId, SpoilerFileName);
                priorPending = new HashSet<string>(prior.PendingTmdb.Keys, StringComparer.OrdinalIgnoreCase);
            }
            catch
            {
                priorPending = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            }

            try
            {
                lock (_userConfigurationManager.GetUserFileLock(authorizedUserId, SpoilerFileName))
                {
                    // Pre-write strict read so a corrupt existing file 503s + backs up
                    // instead of being silently overwritten (same as hidden-content).
                    try
                    {
                        _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(
                            authorizedUserId, SpoilerFileName);
                    }
                    catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
                    {
                        _logger.LogWarning($"{SpoilerFileName} corrupt for {ResolveUserDisplay(authorizedUserId)} (backed up): {strictEx.Message}");
                        return StatusCode(503, new { success = false, message = "Spoiler Guard store is corrupt; backed up. Please retry." });
                    }
                    catch (IOException ioEx)
                    {
                        _logger.LogWarning($"{SpoilerFileName} temporarily unreadable for {ResolveUserDisplay(authorizedUserId)}: {ioEx.Message}");
                        return StatusCode(500, new { success = false, message = "Spoiler Guard store is temporarily unavailable. Please retry." });
                    }

                    _userConfigurationManager.SaveUserConfiguration(authorizedUserId, SpoilerFileName, userConfiguration);
                }

                // Drop the cross-request state cache so the image/strip filters
                // re-read the new state immediately (F7).
                SpoilerUserResolver.InvalidateUser(authorizedUserId);

                // Reconcile the promoter's fast-path gate with the new PendingTmdb
                // set: register keys the payload added, unregister keys it removed.
                // Registration is idempotent, so re-registering survivors is harmless.
                if (Guid.TryParseExact(authorizedUserId, "N", out var gateUserId))
                {
                    foreach (var key in userConfiguration.PendingTmdb.Keys)
                    {
                        SpoilerSeerrPendingPromoter.RegisterPending(key, gateUserId);
                    }
                    foreach (var stale in priorPending)
                    {
                        if (!userConfiguration.PendingTmdb.ContainsKey(stale))
                        {
                            SpoilerSeerrPendingPromoter.UnregisterPending(stale, gateUserId);
                        }
                    }
                }

                _logger.LogInformation($"Saved Spoiler Guard state for {ResolveUserDisplay(authorizedUserId)} to {SpoilerFileName}");
                return Ok(new { success = true, file = SpoilerFileName });
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save Spoiler Guard state for {ResolveUserDisplay(authorizedUserId)}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save Spoiler Guard state." });
            }
        }

        // ─── Corruption health ───────────────────────────────────────────────────
        // Diagnostic surface so an admin (or a user, for their own events) can check
        // whether Spoiler Guard preferences were reset after a corrupt-file backup.
        // Per-user — each user sees only their OWN events; admins see all.

        [HttpGet("spoiler-blur/health")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurHealth()
        {
            // Role-first admin check so Administrator API keys (role claim, no user
            // id) work — same pattern as IsAdminUser() everywhere else.
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null; // admin API key: no user identity, sees all events

            var log = SpoilerUserResolver.GetCorruptionLog();
            var events = new List<object>();
            foreach (var kvp in log)
            {
                if (!isAdmin && kvp.Key != userKey) continue; // non-admin: only own
                events.Add(new
                {
                    userId = kvp.Key,
                    userDisplay = kvp.Value.UserDisplay,
                    at = kvp.Value.At.ToString("o", CultureInfo.InvariantCulture),
                    reason = kvp.Value.Reason,
                });
            }
            return Ok(new
            {
                healthy = events.Count == 0,
                corruptionEvents = events,
            });
        }

        // Admin acks any corruption event (clears the banner); users ack their own.
        [HttpDelete("spoiler-blur/health/{targetUserId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult AckSpoilerBlurCorruption(string targetUserId)
        {
            var isAdmin = IsAdminUser();
            var userId = UserHelper.GetCurrentUserId(User);
            if (!isAdmin && (userId == null || userId == Guid.Empty)) return Forbid();
            var userKey = userId.HasValue && userId.Value != Guid.Empty
                ? userId.Value.ToString("N")
                : null;

            if (!Guid.TryParse(targetUserId, out var tGuid)
                && !Guid.TryParseExact(targetUserId, "N", out tGuid))
            {
                return BadRequest(new { success = false, message = "Invalid userId." });
            }
            var tKey = tGuid.ToString("N");
            if (!isAdmin && tKey != userKey) return Forbid();
            SpoilerUserResolver.ClearCorruption(tKey);
            return Ok(new { success = true });
        }

        // ─── Current-user strict reads (series list + prefs) ─────────────────────

        [HttpGet("spoiler-blur/series")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurSeries()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");

            // Distinguish "file missing" (empty + 200, normal first-time state) from
            // "corrupt/unreadable" (503 + backup-made hint). A lenient read would
            // silently return empty on parse error — the user would think their list
            // was wiped.
            if (!_userConfigurationManager.UserConfigurationExists(userKey, SpoilerFileName))
            {
                return Ok(new UserSpoilerBlur());
            }
            try
            {
                var state = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, SpoilerFileName);
                return Ok(state);
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
        }

        // Per-user override toggles for the admin's strip categories. Nullable bools
        // where null means "inherit admin policy"; SkipDisableConfirm is a permanent
        // flag replacing the per-session "Don't ask for 15 minutes" snooze.
        [HttpGet("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetSpoilerBlurUserPrefs()
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            var userKey = userId.Value.ToString("N");

            if (!_userConfigurationManager.UserConfigurationExists(userKey, SpoilerFileName))
            {
                return Ok(new SpoilerBlurUserPrefs());
            }
            try
            {
                var state = _userConfigurationManager.GetUserConfigurationStrict<UserSpoilerBlur>(userKey, SpoilerFileName);
                return Ok(state.Prefs ?? new SpoilerBlurUserPrefs());
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
        }

        [HttpPost("spoiler-blur/user-prefs")]
        [Authorize]
        [Produces("application/json")]
        [Consumes("application/json")]
        [RequestSizeLimit(8 * 1024)]
        public IActionResult SetSpoilerBlurUserPrefs([FromBody] SpoilerBlurUserPrefs? body)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();
            if (body == null) return BadRequest(new { success = false, message = "Missing body." });

            var userKey = userId.Value.ToString("N");
            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        state.Prefs = new SpoilerBlurUserPrefs
                        {
                            HideEpisodeDescriptions = body.HideEpisodeDescriptions,
                            HideTags = body.HideTags,
                            HideChapterNames = body.HideChapterNames,
                            HideTaglines = body.HideTaglines,
                            HideRatings = body.HideRatings,
                            HideAirDate = body.HideAirDate,
                            ReplaceEpisodeTitles = body.ReplaceEpisodeTitles,
                            HideCast = body.HideCast,
                            HideReviews = body.HideReviews,
                            SkipDisableConfirm = body.SkipDisableConfirm,
                        };
                        return 1;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                return Ok(new { success = true, prefs = body });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to save Spoiler Guard user prefs for {ResolveUserDisplay(userKey)}: {ex.GetType().Name}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save user prefs." });
            }
        }

        // ─── Per-series opt-in ───────────────────────────────────────────────────

        [HttpPost("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid) && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            // Resolve AS THE CALLING USER: GetItemById returns null when filtered out
            // by library access — 404 so we don't leak existence. Any lookup throw is
            // also treated as 404 (arbitrary GUIDs hitting a partially-stored row make
            // Jellyfin's deserializer throw).
            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<BaseItem>(seriesGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"GetItemById<BaseItem> threw for {seriesGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not Series series)
            {
                return NotFound(new { success = false, message = "Series not found or not accessible." });
            }

            var key = seriesGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        // Preserve original EnabledAt on re-toggle; refresh SeriesName
                        // opportunistically (covers renames). Return 0 (no-write) when
                        // truly unchanged so a re-toggle doesn't burn a disk write.
                        if (state.Series.TryGetValue(key, out var existing))
                        {
                            var newName = series.Name ?? existing.SeriesName;
                            if (string.Equals(existing.SeriesName, newName, StringComparison.Ordinal))
                            {
                                return 0;
                            }
                            existing.SeriesName = newName;
                            return 1;
                        }
                        state.Series[key] = new SpoilerBlurSeriesEntry
                        {
                            SeriesId = key,
                            SeriesName = series.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                _logger.LogInformation($"Spoiler Guard enabled for series '{series.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, name = series.Name });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to enable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/series/{seriesId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForSeries(string seriesId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(seriesId, out var seriesGuid) && !Guid.TryParseExact(seriesId, "N", out seriesGuid))
            {
                return BadRequest(new { success = false, message = "Invalid seriesId." });
            }

            var key = seriesGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        removed = state.Series.Remove(key);
                        return removed ? 1 : 0;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                if (!removed)
                {
                    _logger.LogInformation($"Spoiler Guard disable was a no-op for series {key} by {ResolveUserDisplay(userKey)} — series was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, seriesId = key, removed = false });
                }
                _logger.LogInformation($"Spoiler Guard disabled for series {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, seriesId = key, removed = true });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to disable spoiler blur for series {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Per-movie opt-in ────────────────────────────────────────────────────

        public class SpoilerBlurMovieRequest
        {
            public string? MovieName { get; set; }
        }

        [HttpPost("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForMovie(string movieId, [FromBody] SpoilerBlurMovieRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid) && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<BaseItem>(movieGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"GetItemById<BaseItem> threw for {movieGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not Movie movie)
            {
                return NotFound(new { success = false, message = "Movie not found or not accessible." });
            }

            var key = movieGuid.ToString("N");
            var userKey = userId.Value.ToString("N");

            // Sanitize the optional client-provided name: strip HTML tags + angle
            // brackets, cap length. Titles legitimately contain apostrophes/quotes,
            // so those are preserved (consumers render via textContent).
            var movieNameSanitized = SanitizeDisplayName(movie.Name ?? string.Empty, body?.MovieName);

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        if (state.Movies.TryGetValue(key, out var existing))
                        {
                            if (string.Equals(existing.MovieName, movieNameSanitized, StringComparison.Ordinal))
                            {
                                return 0;
                            }
                            existing.MovieName = movieNameSanitized;
                            return 1;
                        }
                        state.Movies[key] = new SpoilerBlurMovieEntry
                        {
                            MovieId = key,
                            MovieName = movieNameSanitized,
                            EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                _logger.LogInformation($"Spoiler Guard enabled for movie '{movie.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, name = movie.Name });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to enable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/movies/{movieId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForMovie(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid) && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var key = movieGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        removed = state.Movies.Remove(key);
                        return removed ? 1 : 0;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                if (!removed)
                {
                    _logger.LogInformation($"Spoiler Guard disable was a no-op for movie {key} by {ResolveUserDisplay(userKey)} — movie was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, movieId = key, removed = false });
                }
                _logger.LogInformation($"Spoiler Guard disabled for movie {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, movieId = key, removed = true });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to disable spoiler blur for movie {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Movie scope probe (for client-side reviews suppression) ─────────────
        // The client can't tell whether a movie is in spoiler scope via a
        // COLLECTION opt-in (that requires the server-side library walk), so it
        // can't decide on its own whether to suppress reviews for a movie. This
        // cheap probe answers "is this movie guarded for ME, and have I played
        // it" so the client can suppress accordingly. Lenient reads throughout:
        // a UI hint must never 503; a missing/corrupt store just yields
        // inScope=false.
        [HttpGet("spoiler-blur/scope/movie/{movieId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult GetMovieSpoilerScope(string movieId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(movieId, out var movieGuid) && !Guid.TryParseExact(movieId, "N", out movieGuid))
            {
                return BadRequest(new { success = false, message = "Invalid movieId." });
            }

            var userKey = userId.Value.ToString("N");
            var state = _userConfigurationManager.GetUserConfiguration<UserSpoilerBlur>(userKey, SpoilerFileName);
            var inScope = _resolver.IsMovieInSpoilerScope(state, movieGuid);

            // Only resolve the item + user-data when the movie is actually in
            // scope — keeps the common not-guarded answer allocation-light.
            var played = false;
            if (inScope)
            {
                var jUser = _userManager.GetUserById(userId.Value);
                if (jUser != null)
                {
                    try
                    {
                        if (_libraryManager.GetItemById<BaseItem>(movieGuid, jUser) is Movie movie)
                        {
                            played = _userDataManager.GetUserData(jUser, movie)?.Played == true;
                        }
                    }
                    catch (Exception ex)
                    {
                        // Inaccessible / partially-stored row — leave played=false.
                        _logger.LogWarning($"GetMovieSpoilerScope: item/user-data lookup threw for {movieGuid}: {ex.GetType().Name}: {ex.Message}");
                    }
                }
            }

            return Ok(new { inScope, played });
        }

        // ─── Per-collection opt-in (shortcut: protects member movies) ────────────

        public class SpoilerBlurCollectionRequest
        {
            public string? CollectionName { get; set; }
        }

        [HttpPost("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [RequestSizeLimit(8 * 1024)]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurForCollection(string collectionId, [FromBody] SpoilerBlurCollectionRequest? body = null)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid) && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();
            BaseItem? item = null;
            try
            {
                item = _libraryManager.GetItemById<BaseItem>(collGuid, jUser);
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"GetItemById<BaseItem> threw for {collGuid}: {ex.GetType().Name}: {ex.Message}");
            }
            if (item is not BoxSet boxSet)
            {
                return NotFound(new { success = false, message = "Collection not found or not accessible." });
            }

            var key = collGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            var collNameSanitized = SanitizeDisplayName(boxSet.Name ?? string.Empty, body?.CollectionName);

            try
            {
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        if (state.Collections.TryGetValue(key, out var existing))
                        {
                            if (string.Equals(existing.CollectionName, collNameSanitized, StringComparison.Ordinal))
                            {
                                return 0;
                            }
                            existing.CollectionName = collNameSanitized;
                            return 1;
                        }
                        state.Collections[key] = new SpoilerBlurCollectionEntry
                        {
                            CollectionId = key,
                            CollectionName = collNameSanitized,
                            EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                _logger.LogInformation($"Spoiler Guard enabled for collection '{boxSet.Name}' ({key}) by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, name = boxSet.Name });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to enable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        [HttpDelete("spoiler-blur/collections/{collectionId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurForCollection(string collectionId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!Guid.TryParse(collectionId, out var collGuid) && !Guid.TryParseExact(collectionId, "N", out collGuid))
            {
                return BadRequest(new { success = false, message = "Invalid collectionId." });
            }

            var key = collGuid.ToString("N");
            var userKey = userId.Value.ToString("N");
            try
            {
                bool removed = false;
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        removed = state.Collections.Remove(key);
                        return removed ? 1 : 0;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                if (!removed)
                {
                    _logger.LogInformation($"Spoiler Guard disable was a no-op for collection {key} by {ResolveUserDisplay(userKey)} — collection was not in the user's spoiler-blur list.");
                    return Ok(new { success = true, collectionId = key, removed = false });
                }
                _logger.LogInformation($"Spoiler Guard disabled for collection {key} by {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, collectionId = key, removed = true });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to disable spoiler blur for collection {key}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler blur state." });
            }
        }

        // ─── Pre-acquisition pending (Seerr / not-yet-downloaded) ────────────────

        [HttpPost("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult EnableSpoilerBlurPending(string mediaType, string tmdbId, [FromQuery] string? displayName = null)
        {
            if (_configProvider.ConfigurationOrNull?.SpoilerBlurEnabled != true)
            {
                return StatusCode(503, new { success = false, message = "Spoiler Guard is disabled by the administrator." });
            }

            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!TryNormalizePendingRoute(mediaType, tmdbId, out var normalizedType, out var canonicalTmdb, out var routeError))
            {
                return routeError!;
            }

            var jUser = _userManager.GetUserById(userId.Value);
            if (jUser == null) return Forbid();

            var userKey = userId.Value.ToString("N");
            try
            {
                var summary = _pendingService.AddPending(userId.Value, jUser, normalizedType, canonicalTmdb, displayName);
                if (summary.Promoted == "cap-exceeded")
                {
                    return StatusCode(429, new
                    {
                        success = false,
                        code = "pending_cap_exceeded",
                        message = $"You already have the maximum of {SpoilerPendingService.MaxPendingTmdbPerUser} pending spoiler-blur entries. Remove some via the management UI before adding more."
                    });
                }
                return Ok(new { success = true, promoted = summary.Promoted, jellyfinId = summary.JellyfinId, name = summary.Name });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to record spoiler-blur pending {normalizedType}:{canonicalTmdb}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        [HttpDelete("spoiler-blur/pending/{mediaType}/{tmdbId}")]
        [Authorize]
        [Produces("application/json")]
        public IActionResult DisableSpoilerBlurPending(string mediaType, string tmdbId)
        {
            var userId = UserHelper.GetCurrentUserId(User);
            if (userId == null || userId == Guid.Empty) return Forbid();

            if (!TryNormalizePendingRoute(mediaType, tmdbId, out var normalizedType, out var canonicalTmdb, out var routeError))
            {
                return routeError!;
            }

            var pendingKey = $"{normalizedType}:{canonicalTmdb}";
            var userKey = userId.Value.ToString("N");

            // Mirror the POST abstraction: the modal's "Disable spoiler" click needn't
            // know whether the entry is pending or in Series/Movies. Resolve TMDB ->
            // Jellyfin id and remove from whichever side holds it. Pre-compute the id
            // outside the RMW so we don't capture mutated locals into the lambda.
            var jUser = _userManager.GetUserById(userId.Value);
            try
            {
                var existingItem = jUser != null
                    ? _pendingService.FindLibraryItemByTmdb(jUser, normalizedType, canonicalTmdb)
                    : null;
                var seriesKeyToRemove = (existingItem as Series)?.Id.ToString("N");
                var movieKeyToRemove = (existingItem as Movie)?.Id.ToString("N");
                var resultBox = new[] { (Removed: false, From: "none", JellyfinId: (string?)null) };
                _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, SpoilerFileName, state =>
                    {
                        bool pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        bool seriesRemoved = seriesKeyToRemove != null && state.Series.Remove(seriesKeyToRemove);
                        bool movieRemoved = movieKeyToRemove != null && state.Movies.Remove(movieKeyToRemove);
                        if (seriesRemoved) resultBox[0] = (true, "series", seriesKeyToRemove);
                        else if (movieRemoved) resultBox[0] = (true, "movie", movieKeyToRemove);
                        else if (pendingRemoved) resultBox[0] = (true, "pending", null);
                        return resultBox[0].Removed ? 1 : 0;
                    });
                SpoilerUserResolver.InvalidateUser(userKey);
                // Either way the key is no longer pending for this user — keep the
                // promoter's gate consistent so it stops sweeping this user.
                SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId.Value);
                var (removedAnything, removedFrom, removedJellyfinId) = resultBox[0];
                if (!removedAnything)
                {
                    return Ok(new { success = true, removed = false, removedFrom = "none" });
                }
                _logger.LogInformation($"Spoiler Guard pending DELETE removed {pendingKey} ({removedFrom}) for {ResolveUserDisplay(userKey)}");
                return Ok(new { success = true, removed = true, removedFrom, jellyfinId = removedJellyfinId });
            }
            catch (Exception strictEx) when (strictEx is InvalidDataException || strictEx is JsonException)
            {
                return CorruptStore(userKey, strictEx);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to remove spoiler-blur pending {pendingKey}: {ex.Message}");
                return StatusCode(500, new { success = false, message = "Failed to save spoiler-blur pending state." });
            }
        }

        // ─── Shared helpers ──────────────────────────────────────────────────────

        // Validates the {mediaType}/{tmdbId} route pair shared by the pending
        // POST/DELETE. mediaType must be tv|movie; tmdbId a positive integer.
        private bool TryNormalizePendingRoute(
            string mediaType, string tmdbId,
            out string normalizedType, out string canonicalTmdb, out IActionResult? error)
        {
            normalizedType = (mediaType ?? string.Empty).ToLowerInvariant();
            canonicalTmdb = string.Empty;
            error = null;

            if (normalizedType != "tv" && normalizedType != "movie")
            {
                error = BadRequest(new { success = false, message = "mediaType must be 'tv' or 'movie'." });
                return false;
            }
            // TMDB ids are positive integers; reject anything else so we don't store
            // junk keys the promoter would never match.
            if (string.IsNullOrWhiteSpace(tmdbId)
                || !int.TryParse(tmdbId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdbInt)
                || tmdbInt <= 0)
            {
                error = BadRequest(new { success = false, message = "Invalid tmdbId." });
                return false;
            }
            canonicalTmdb = tmdbInt.ToString(CultureInfo.InvariantCulture);
            return true;
        }

        // Sanitizes an optional client-supplied display name over a server-derived
        // fallback: strip HTML tags + angle brackets, cap at 200 chars, and only
        // override the fallback when something usable remains.
        private static string SanitizeDisplayName(string fallback, string? clientName)
        {
            if (clientName is not string raw || string.IsNullOrEmpty(raw)) return fallback;
            var cleaned = System.Text.RegularExpressions.Regex.Replace(raw, "<[^>]+>", string.Empty);
            cleaned = cleaned.Replace("<", string.Empty).Replace(">", string.Empty);
            if (cleaned.Length > 200) cleaned = cleaned.Substring(0, 200);
            return string.IsNullOrWhiteSpace(cleaned) ? fallback : cleaned;
        }
    }
}
