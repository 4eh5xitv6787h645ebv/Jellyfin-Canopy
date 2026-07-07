using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinElevate.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Shared core for the pre-acquisition ("pending") Spoiler Guard flow. Owns the
    /// TMDB→library lookup, the pending-entry cap, the display-name sanitizer and the
    /// RMW promote/record logic so BOTH the HTTP endpoint (SpoilerGuardController's
    /// POST/DELETE spoiler-blur/pending) AND the fire-and-forget Seerr auto-request
    /// hook (JellyseerrProxyController) reuse one implementation.
    ///
    /// Registered as a singleton. Deliberately depends only on the config store,
    /// ILibraryManager and IUserManager — never on IJellyseerrClient — so it can be
    /// consumed by the Seerr proxy controller without introducing a DI cycle.
    /// </summary>
    public sealed class SpoilerPendingService
    {
        // Hard cap on PendingTmdb — defensive against an auth'd user spamming the
        // modal/Seerr hook to grow spoilerblur.json without bound. 500 is well above
        // any real watchlist. Reaching it rejects NEW inserts only; existing entries
        // still promote and DELETE still works, so users can prune to recover.
        public const int MaxPendingTmdbPerUser = 500;

        private readonly UserConfigurationManager _userConfigurationManager;
        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;
        private readonly ILogger<SpoilerPendingService> _logger;

        public SpoilerPendingService(
            UserConfigurationManager userConfigurationManager,
            ILibraryManager libraryManager,
            IUserManager userManager,
            ILogger<SpoilerPendingService> logger)
        {
            _userConfigurationManager = userConfigurationManager;
            _libraryManager = libraryManager;
            _userManager = userManager;
            _logger = logger;
        }

        /// <summary>
        /// Structured outcome shared by the HTTP layer and the fire-and-forget log layer.
        /// <c>Promoted</c> is one of "series", "movie", "pending" or "cap-exceeded".
        /// </summary>
        public sealed record SpoilerBlurPendingResult(string Promoted, string? JellyfinId, string? Name, bool WroteSomething);

        // ─── Shared core (manual POST + auto-on-Seerr-request) ───────────────────
        // Library lookup + RMW. Strict-read corruption (InvalidDataException /
        // JsonException) propagates to the caller so the HTTP endpoint can 503; the
        // Seerr hook wraps this in a log-and-swallow.
        public SpoilerBlurPendingResult AddPending(
            Guid userId,
            JUser jUser,
            string mediaType,
            string canonicalTmdb,
            string? displayName)
        {
            var pendingKey = $"{mediaType}:{canonicalTmdb}";
            var userKey = userId.ToString("N");
            var fileName = SpoilerBlurImageFilter.SpoilerBlurFileName;
            var existingItem = FindLibraryItemByTmdb(jUser, mediaType, canonicalTmdb);

            if (existingItem is Series existingSeries)
            {
                var seriesKey = existingSeries.Id.ToString("N");
                var changed = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        if (state.Series.ContainsKey(seriesKey)) return pendingRemoved ? 1 : 0;
                        state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                        {
                            SeriesId = seriesKey,
                            SeriesName = existingSeries.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId);
                SpoilerUserResolver.InvalidateUser(userKey); // F7: state changed (Series/Movies)
                _logger.LogInformation($"Spoiler Guard pending resolved to existing series '{existingSeries.Name}' ({seriesKey}) for {ResolveUserDisplay(userKey)}");
                return new SpoilerBlurPendingResult("series", seriesKey, existingSeries.Name, changed > 0);
            }
            if (existingItem is Movie existingMovie)
            {
                var movieKey = existingMovie.Id.ToString("N");
                var changed = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                    userKey, fileName, state =>
                    {
                        var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                        if (state.Movies.ContainsKey(movieKey)) return pendingRemoved ? 1 : 0;
                        state.Movies[movieKey] = new SpoilerBlurMovieEntry
                        {
                            MovieId = movieKey,
                            MovieName = existingMovie.Name ?? string.Empty,
                            EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                        };
                        return 1;
                    });
                SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId);
                SpoilerUserResolver.InvalidateUser(userKey); // F7: state changed (Series/Movies)
                _logger.LogInformation($"Spoiler Guard pending resolved to existing movie '{existingMovie.Name}' ({movieKey}) for {ResolveUserDisplay(userKey)}");
                return new SpoilerBlurPendingResult("movie", movieKey, existingMovie.Name, changed > 0);
            }

            var sanitized = SanitizePendingDisplayName(displayName);
            var capExceeded = new[] { false };
            var pendingChanged = _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    if (state.PendingTmdb.TryGetValue(pendingKey, out var existing))
                    {
                        if (string.Equals(existing.DisplayName, sanitized, StringComparison.Ordinal))
                        {
                            return 0;
                        }
                        existing.DisplayName = sanitized;
                        return 1;
                    }
                    if (state.PendingTmdb.Count >= MaxPendingTmdbPerUser)
                    {
                        capExceeded[0] = true;
                        return 0;
                    }
                    state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
                    {
                        MediaType = mediaType,
                        TmdbId = canonicalTmdb,
                        DisplayName = sanitized,
                        RequestedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            if (capExceeded[0])
            {
                _logger.LogWarning($"Spoiler Guard pending: cap of {MaxPendingTmdbPerUser} reached for {ResolveUserDisplay(userKey)} — rejecting new {pendingKey}");
                return new SpoilerBlurPendingResult("cap-exceeded", null, null, false);
            }
            // Prime the promoter's fast-path gate so the next ItemAdded matching this
            // TMDB id sweeps THIS user instead of bailing.
            SpoilerSeerrPendingPromoter.RegisterPending(pendingKey, userId);
            _logger.LogInformation($"Spoiler Guard pending recorded {pendingKey} for {ResolveUserDisplay(userKey)} (not yet in library)");

            // TOCTOU recovery: the scanner may have added the item between the
            // top-of-method lookup and this write — ItemAdded fired before our
            // pending row existed, so the promoter skipped this user. Re-check once
            // and promote inline if so.
            try
            {
                var raceItem = FindLibraryItemByTmdb(jUser, mediaType, canonicalTmdb);
                if (raceItem is Series rs)
                {
                    return PromotePendingToSeries(userId, userKey, fileName, rs, pendingKey);
                }
                if (raceItem is Movie rm)
                {
                    return PromotePendingToMovie(userId, userKey, fileName, rm, pendingKey);
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Spoiler Guard pending TOCTOU recheck threw {ex.GetType().Name}: {ex.Message}");
            }
            return new SpoilerBlurPendingResult("pending", null, null, pendingChanged > 0);
        }

        private SpoilerBlurPendingResult PromotePendingToSeries(
            Guid userId, string userKey, string fileName, Series series, string pendingKey)
        {
            var seriesKey = series.Id.ToString("N");
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                    if (state.Series.ContainsKey(seriesKey)) return pendingRemoved ? 1 : 0;
                    state.Series[seriesKey] = new SpoilerBlurSeriesEntry
                    {
                        SeriesId = seriesKey,
                        SeriesName = series.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId);
            SpoilerUserResolver.InvalidateUser(userKey); // F7: state changed (Series)
            _logger.LogInformation($"Spoiler Guard pending TOCTOU-promoted to series '{series.Name}' ({seriesKey}) for {ResolveUserDisplay(userKey)}");
            return new SpoilerBlurPendingResult("series", seriesKey, series.Name, true);
        }

        private SpoilerBlurPendingResult PromotePendingToMovie(
            Guid userId, string userKey, string fileName, Movie movie, string pendingKey)
        {
            var movieKey = movie.Id.ToString("N");
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey, fileName, state =>
                {
                    var pendingRemoved = state.PendingTmdb.Remove(pendingKey);
                    if (state.Movies.ContainsKey(movieKey)) return pendingRemoved ? 1 : 0;
                    state.Movies[movieKey] = new SpoilerBlurMovieEntry
                    {
                        MovieId = movieKey,
                        MovieName = movie.Name ?? string.Empty,
                        EnabledAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                    };
                    return 1;
                });
            SpoilerSeerrPendingPromoter.UnregisterPending(pendingKey, userId);
            SpoilerUserResolver.InvalidateUser(userKey); // F7: state changed (Movies)
            _logger.LogInformation($"Spoiler Guard pending TOCTOU-promoted to movie '{movie.Name}' ({movieKey}) for {ResolveUserDisplay(userKey)}");
            return new SpoilerBlurPendingResult("movie", movieKey, movie.Name, true);
        }

        /// <summary>
        /// Returns the library item matching the TMDB id + media type, filtered by the
        /// user's access (null when not found/accessible). Uses HasAnyProviderId so the
        /// DB does the (indexed) matching rather than a client-side scan. Public so the
        /// pending-DELETE endpoint can resolve TMDB→Jellyfin id for the same abstraction.
        /// </summary>
        public BaseItem? FindLibraryItemByTmdb(JUser user, string mediaType, string tmdbId)
        {
            var kind = mediaType == "movie"
                ? Jellyfin.Data.Enums.BaseItemKind.Movie
                : Jellyfin.Data.Enums.BaseItemKind.Series;
            try
            {
                var query = new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { kind },
                    HasAnyProviderId = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                    {
                        { "Tmdb", tmdbId },
                    },
                    Recursive = true,
                    Limit = 1,
                };
                var items = _libraryManager.GetItemList(query);
                if (items != null && items.Count > 0)
                {
                    return items[0];
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"FindLibraryItemByTmdb({mediaType}, {tmdbId}) threw {ex.GetType().Name}: {ex.Message}");
            }
            return null;
        }

        // Off-thread continuation for the Seerr auto-request hook — must NOT touch
        // HttpContext / User (userId is captured by the caller before Task.Run). Parses
        // the cloned request body, resolves the user, and delegates to AddPending.
        // Log-and-swallow: a Spoiler Guard failure must never surface on the request.
        public void TryAutoEnableFromSeerrRequest(Guid userId, JsonElement requestBody)
        {
            try
            {
                if (requestBody.ValueKind != JsonValueKind.Object) return;
                if (!requestBody.TryGetProperty("mediaType", out var mtProp) || mtProp.ValueKind != JsonValueKind.String) return;
                if (!requestBody.TryGetProperty("mediaId", out var miProp)) return;

                var rawType = mtProp.GetString();
                if (string.IsNullOrEmpty(rawType)) return;
                var mediaType = rawType.ToLowerInvariant();
                if (mediaType != "tv" && mediaType != "movie") return;

                int tmdbInt;
                if (miProp.ValueKind == JsonValueKind.Number)
                {
                    if (!miProp.TryGetInt32(out tmdbInt) || tmdbInt <= 0) return;
                }
                else if (miProp.ValueKind == JsonValueKind.String)
                {
                    if (!int.TryParse(miProp.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out tmdbInt)
                        || tmdbInt <= 0) return;
                }
                else
                {
                    return;
                }

                var jUser = _userManager.GetUserById(userId);
                if (jUser == null) return;

                var canonicalTmdb = tmdbInt.ToString(CultureInfo.InvariantCulture);
                var summary = AddPending(userId, jUser, mediaType, canonicalTmdb, displayName: null);
                if (summary.WroteSomething)
                {
                    _logger.LogInformation($"Spoiler Guard auto-on-request {summary.Promoted} for {mediaType}:{canonicalTmdb} by {ResolveUserDisplay(userId.ToString("N"))}");
                }
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Spoiler Guard auto-on-request task threw {ex.GetType().Name}: {ex.Message}");
            }
        }

        // Clamp + strip control / format chars so a poisoned modal payload can't grow
        // spoilerblur.json without bound or sneak null bytes / bidi-override (U+202E)
        // tricks through the JSON serializer + management UI. Strips Unicode Cf
        // (Format) and Cc (Control) categories explicitly so RTL spoofing (e.g.
        // `‮gnP.exe`) is neutralized. Truncates surrogate-pair-safe so we don't emit
        // lone surrogates.
        internal static string SanitizePendingDisplayName(string? raw)
        {
            if (string.IsNullOrEmpty(raw)) return string.Empty;
            const int max = 200;
            int end = raw.Length > max ? max : raw.Length;
            if (end > 0 && end < raw.Length && char.IsHighSurrogate(raw[end - 1]))
            {
                end -= 1;
            }
            var s = raw.Substring(0, end);
            var buf = new StringBuilder(s.Length);
            foreach (var c in s)
            {
                if (c == '\r' || c == '\n' || c == '\t') { buf.Append(' '); continue; }
                var cat = CharUnicodeInfo.GetUnicodeCategory(c);
                if (cat == UnicodeCategory.Control || cat == UnicodeCategory.Format)
                {
                    continue;
                }
                buf.Append(c);
            }
            return buf.ToString().Normalize(NormalizationForm.FormC);
        }

        private string ResolveUserDisplay(string userIdN)
        {
            try
            {
                if (Guid.TryParse(userIdN, out var guid) || Guid.TryParseExact(userIdN, "N", out guid))
                {
                    var user = _userManager.GetUserById(guid);
                    if (user != null) return $"{user.Username} ({userIdN})";
                }
            }
            catch { /* non-fatal */ }
            return userIdN;
        }
    }
}
