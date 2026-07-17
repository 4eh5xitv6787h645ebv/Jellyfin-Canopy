using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Shared core for the pre-acquisition ("pending") Spoiler Guard flow. Owns the
    /// TMDB→library lookup, the pending-entry cap, the display-name sanitizer and the
    /// RMW promote/record logic so BOTH the HTTP endpoint (SpoilerGuardController's
    /// POST/DELETE spoiler-blur/pending) and the synchronous SeerrClient success
    /// boundary reuse one implementation.
    ///
    /// Registered as a singleton. Deliberately depends only on the config store,
    /// ILibraryManager and IUserManager — never on ISeerrClient — so it can be
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

        /// <summary>
        /// Raised after the durable store has changed (or an existing durable row
        /// has been re-observed).  The hosted promoter treats this only as a
        /// bounded acceleration signal; <c>spoilerblur.json</c> remains the replay
        /// authority when no worker is running or its queue is saturated.
        /// </summary>
        internal event Action<string, Guid, bool>? PendingRegistrationChanged;

        internal Action? BeforeCapFallbackForTest { get; set; }

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
        /// Structured outcome shared by the HTTP layer and Seerr intent registration.
        /// <c>Promoted</c> is one of "series", "movie", "pending" or "cap-exceeded".
        /// </summary>
        public sealed record SpoilerBlurPendingResult(string Promoted, string? JellyfinId, string? Name, bool WroteSomething);

        /// <summary>
        /// Result of synchronously recording the local half of a successful Seerr
        /// media request.  A successful result means either PendingTmdb or the
        /// final Series/Movies collection was atomically persisted before the
        /// caller received the Seerr acknowledgment.
        /// </summary>
        internal sealed record SeerrIntentRegistration(bool IsDurable, string Code, string? PendingKey = null);

        /// <summary>
        /// Persists the smallest replayable Spoiler Guard intent without doing a
        /// library query first.  Promotion is signalled only after the strict RMW
        /// returns, so an accepted worker item can never outrun its durable row.
        /// </summary>
        internal SeerrIntentRegistration RegisterSeerrIntent(Guid userId, string? requestBody)
        {
            if (!TryParseSeerrRequestTarget(
                    requestBody,
                    out var mediaType,
                    out var canonicalTmdb,
                    out var parseFailureCode))
            {
                return new SeerrIntentRegistration(false, parseFailureCode);
            }

            var jUser = _userManager.GetUserById(userId);
            if (jUser == null)
            {
                return new SeerrIntentRegistration(false, "jellyfin_user_unavailable");
            }

            var pendingKey = $"{mediaType}:{canonicalTmdb}";
            var userKey = userId.ToString("N");
            var capExceeded = false;
            _userConfigurationManager.RmwUserConfiguration<UserSpoilerBlur>(
                userKey,
                SpoilerBlurImageFilter.SpoilerBlurFileName,
                state =>
                {
                    if (state.PendingTmdb.ContainsKey(pendingKey))
                    {
                        return 0;
                    }

                    if (state.PendingTmdb.Count >= MaxPendingTmdbPerUser)
                    {
                        capExceeded = true;
                        return 0;
                    }

                    state.PendingTmdb[pendingKey] = new SpoilerBlurPendingEntry
                    {
                        MediaType = mediaType,
                        TmdbId = canonicalTmdb,
                        DisplayName = string.Empty,
                        RequestedAt = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture),
                    };
                    return 1;
                });

            SpoilerUserResolver.InvalidateUser(userKey);
            if (!capExceeded)
            {
                NotifyPendingRegistered(pendingKey, userId);
                return new SeerrIntentRegistration(true, "recorded", pendingKey);
            }

            // Preserve the pre-existing cap contract: an already-present,
            // accessible title can still be protected directly even when all 500
            // pre-acquisition slots are occupied.  This synchronous fallback is
            // also durable before acknowledgment; only unresolved titles fail with
            // the explicit partial-success contract at the Seerr boundary.
            BeforeCapFallbackForTest?.Invoke();
            var promoted = AddPending(userId, jUser, mediaType, canonicalTmdb, displayName: null);
            return promoted.Promoted switch
            {
                "series" or "movie" => new SeerrIntentRegistration(true, "promoted", pendingKey),
                // Capacity may open between the first strict cap check and the
                // compatibility fallback. AddPending's `pending` result proves
                // the target row is now durable, whether this invocation wrote it
                // or re-observed a concurrent writer.
                "pending" => new SeerrIntentRegistration(true, "recorded", pendingKey),
                _ => new SeerrIntentRegistration(false, "pending_cap_exceeded", pendingKey),
            };
        }

        private static bool TryParseSeerrRequestTarget(
            string? requestBody,
            out string mediaType,
            out string canonicalTmdb,
            out string failureCode)
        {
            mediaType = string.Empty;
            canonicalTmdb = string.Empty;
            failureCode = "invalid_request_target";
            if (string.IsNullOrWhiteSpace(requestBody))
            {
                return false;
            }

            try
            {
                using var document = JsonDocument.Parse(requestBody);
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object
                    || !root.TryGetProperty("mediaType", out var mediaTypeElement)
                    || mediaTypeElement.ValueKind != JsonValueKind.String
                    || !root.TryGetProperty("mediaId", out var mediaIdElement))
                {
                    return false;
                }

                mediaType = mediaTypeElement.GetString()?.Trim().ToLowerInvariant() ?? string.Empty;
                if (mediaType is not ("tv" or "movie"))
                {
                    failureCode = "unsupported_request_target";
                    return false;
                }

                int tmdbId;
                if (mediaIdElement.ValueKind == JsonValueKind.Number)
                {
                    if (!mediaIdElement.TryGetInt32(out tmdbId))
                    {
                        return false;
                    }
                }
                else if (mediaIdElement.ValueKind == JsonValueKind.String)
                {
                    if (!int.TryParse(
                            mediaIdElement.GetString(),
                            NumberStyles.Integer,
                            CultureInfo.InvariantCulture,
                            out tmdbId))
                    {
                        return false;
                    }
                }
                else
                {
                    return false;
                }

                if (tmdbId <= 0)
                {
                    return false;
                }

                canonicalTmdb = tmdbId.ToString(CultureInfo.InvariantCulture);
                return true;
            }
            catch (JsonException)
            {
                return false;
            }
        }

        internal void NotifyPendingRegistered(string pendingKey, Guid userId)
        {
            if (string.IsNullOrEmpty(pendingKey) || userId == Guid.Empty)
            {
                return;
            }

            PendingRegistrationChanged?.Invoke(pendingKey, userId, true);
        }

        internal void NotifyPendingRemoved(string pendingKey, Guid userId)
        {
            if (string.IsNullOrEmpty(pendingKey) || userId == Guid.Empty)
            {
                return;
            }

            PendingRegistrationChanged?.Invoke(pendingKey, userId, false);
        }

        // ─── Shared core (manual POST + cap-full Seerr fallback) ─────────────────
        // Library lookup + RMW. Strict-read corruption (InvalidDataException /
        // JsonException) propagates to the caller so the HTTP endpoint can 503; the
        // SeerrClient converts this into an explicit partial-success response.
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
                NotifyPendingRemoved(pendingKey, userId);
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
                NotifyPendingRemoved(pendingKey, userId);
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
            // The strict RMW above proved spoilerblur.json is currently readable and
            // valid, so drop any cached FailClosed / stale enforcement state for this
            // user (repair invalidation, matching the promotion and existing-item
            // branches) — even on the no-change or cap-exceeded outcome.
            SpoilerUserResolver.InvalidateUser(userKey);
            if (capExceeded[0])
            {
                _logger.LogWarning($"Spoiler Guard pending: cap of {MaxPendingTmdbPerUser} reached for {ResolveUserDisplay(userKey)} — rejecting new {pendingKey}");
                return new SpoilerBlurPendingResult("cap-exceeded", null, null, false);
            }
            // Prime the promoter's fast-path gate so the next ItemAdded matching this
            // TMDB id sweeps THIS user instead of bailing.
            NotifyPendingRegistered(pendingKey, userId);
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
            NotifyPendingRemoved(pendingKey, userId);
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
            NotifyPendingRemoved(pendingKey, userId);
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
