using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    public static class SeerrUserImportHelper
    {
        public static HashSet<string> GetBlockedUserIds(string? blockedUsersConfig)
        {
            if (string.IsNullOrEmpty(blockedUsersConfig))
            {
                return new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            }

            return blockedUsersConfig
                .Split(new[] { ',', '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(id => id.Trim().Replace("-", ""))
                .Where(id => !string.IsNullOrEmpty(id))
                .ToHashSet(StringComparer.OrdinalIgnoreCase);
        }

        public class BulkImportResult
        {
            public int Imported { get; set; }
            public bool Reached { get; set; }
            public bool Succeeded { get; set; }
            public string? SourceUrl { get; set; }
            public List<string> Errors { get; set; } = new();
        }

        public static async Task<BulkImportResult> BulkImportAsync(
            List<string> userIds,
            string[] urls,
            string apiKey,
            IHttpClientFactory httpClientFactory,
            ILogger logger,
            CancellationToken cancellationToken = default,
            Func<bool>? canDispatch = null)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var result = new BulkImportResult();
            var httpClient = SeerrHttpHelper.CreateClient(httpClientFactory);
            httpClient.Timeout = TimeSpan.FromSeconds(30);

            var normalizedUserIds = userIds
                .Select(userId => userId.Trim()
                    .Replace("-", string.Empty, StringComparison.Ordinal)
                    .ToLowerInvariant())
                .Where(userId => userId.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var sources = urls
                .SelectMany(url => (url ?? string.Empty).Split(
                    new[] { '\r', '\n', ',' },
                    StringSplitOptions.RemoveEmptyEntries))
                .Select(SeerrUrlIdentity.Normalize)
                .Where(url => url != null)
                .Select(url => url!)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            var sourceUrl = sources.FirstOrDefault();
            if (sourceUrl == null)
            {
                result.Errors.Add("No valid Seerr URL is configured for user import.");
                return result;
            }

            result.SourceUrl = sourceUrl;
            cancellationToken.ThrowIfCancellationRequested();
            if (normalizedUserIds.Count == 0)
            {
                result.Succeeded = true;
                return result;
            }

            // Stage a stable, complete user map from every identity domain
            // before creating anything. A user already linked on B must never
            // be imported into A merely because A is the selected mutation
            // target; that would create duplicate ownership and change future
            // first-match resolution. No preflight prefix is usable: one
            // incomplete or invalid domain suppresses the mutation entirely.
            var userSnapshots = await SeerrPaginationHelper.FetchAllSourcesAsync(
                httpClient,
                sources,
                static (baseUrl, _, skip) => $"{baseUrl}/api/v1/user?take=1000&skip={skip}",
                apiKey,
                apiUserId: null,
                requestedPageSize: 1000,
                UserCollectionIdentity,
                cancellationToken).ConfigureAwait(false);
            if (!userSnapshots.IsComplete)
            {
                var message = $"User import preflight was incomplete at {userSnapshots.FailedSourceUrl ?? "a configured Seerr domain"}: {userSnapshots.FailureReason ?? "No complete user map was available."}";
                logger.LogWarning(message);
                result.Errors.Add(message);
                return result;
            }

            if (!TryCollectMappedUserIds(userSnapshots, out var mappedUserIds, out var mapFailure))
            {
                var message = $"User import preflight was invalid: {mapFailure}";
                logger.LogWarning(message);
                result.Errors.Add(message);
                return result;
            }

            result.Reached = true;
            var unboundUserIds = normalizedUserIds
                .Where(userId => !mappedUserIds.Contains(userId))
                .ToList();
            if (unboundUserIds.Count == 0)
            {
                result.Succeeded = true;
                return result;
            }

            // The first complete snapshot is only preparation. User ownership
            // may change while a large import batch is being assembled, so
            // prove the same complete all-domain map again immediately before
            // the non-idempotent POST. This is deliberately a second stable
            // pagination read, not a cache lookup or a target-domain-only check.
            var dispatchSnapshots = await SeerrPaginationHelper.FetchAllSourcesAsync(
                httpClient,
                sources,
                static (baseUrl, _, skip) => $"{baseUrl}/api/v1/user?take=1000&skip={skip}",
                apiKey,
                apiUserId: null,
                requestedPageSize: 1000,
                UserCollectionIdentity,
                cancellationToken).ConfigureAwait(false);
            if (!dispatchSnapshots.IsComplete)
            {
                var message = $"User import dispatch preflight was incomplete at {dispatchSnapshots.FailedSourceUrl ?? "a configured Seerr domain"}: {dispatchSnapshots.FailureReason ?? "No complete user map was available."}";
                logger.LogWarning(message);
                result.Errors.Add(message);
                return result;
            }

            if (!TryCollectMappedUserIds(dispatchSnapshots, out var currentMappedUserIds, out var currentMapFailure))
            {
                var message = $"User import dispatch preflight was invalid: {currentMapFailure}";
                logger.LogWarning(message);
                result.Errors.Add(message);
                return result;
            }

            if (!UserMapsMatch(userSnapshots, dispatchSnapshots)
                || !mappedUserIds.SetEquals(currentMappedUserIds))
            {
                const string message = "User import dispatch preflight disagreed with the prepared all-domain user map; no users were imported.";
                logger.LogWarning(message);
                result.Errors.Add(message);
                return result;
            }

            cancellationToken.ThrowIfCancellationRequested();
            if (canDispatch != null && !canDispatch())
            {
                const string message = "User import authorization or configuration changed during preparation; no users were imported.";
                logger.LogWarning(message);
                result.Errors.Add(message);
                return result;
            }

            var requestBody = JsonSerializer.Serialize(new { jellyfinUserIds = unboundUserIds });
            var requestUri = $"{sourceUrl}/api/v1/user/import-from-jellyfin";

            // User creation is not idempotent and distinct configured URLs are
            // separate identity domains, not replicas. Once this POST is
            // dispatched its commit state is uncertain on every failure path,
            // so this attempt must never be replayed against another URL.
            try
            {
                using var request = SeerrHttpHelper.BuildRequest(
                    HttpMethod.Post, requestUri, apiKey, bodyJson: requestBody);
                using var response = await httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
                result.Reached = true;

                var (json, error) = await SeerrHttpHelper.ReadResponseAsync(
                    response,
                    requestUri,
                    cancellationToken).ConfigureAwait(false);
                if (error != null)
                {
                    var msg = $"Import failed at {sourceUrl}: {error.Code} {error.HttpStatus} — {error.Message}";
                    logger.LogWarning(msg);
                    result.Errors.Add(msg);
                    return result;
                }

                var importedUsers = JsonSerializer.Deserialize<JsonElement>(json!);
                if (importedUsers.ValueKind != JsonValueKind.Array)
                {
                    throw new JsonException("The Seerr import response was not a JSON array.");
                }

                result.Imported = importedUsers.GetArrayLength();
                result.Succeeded = true;
                return result;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException ex)
            {
                logger.LogWarning($"Timed out during bulk import at {sourceUrl}: {ex.Message}");
                result.Errors.Add($"Import timed out at {sourceUrl}; its commit state is unknown and it was not replayed.");
                return result;
            }
            catch (HttpRequestException ex)
            {
                logger.LogDebug($"Connection error during bulk import at {sourceUrl}: {ex.Message}");
                result.Errors.Add($"Connection error at {sourceUrl}: {ex.Message}");
                return result;
            }
            catch (JsonException ex)
            {
                logger.LogWarning($"Invalid response from Seerr during bulk import at {sourceUrl}: {ex.Message}");
                result.Errors.Add($"Invalid response at {sourceUrl}: {ex.Message}");
                result.Reached = true;
                return result;
            }
            catch (Exception ex)
            {
                logger.LogWarning($"Unexpected failure during bulk import at {sourceUrl}: {ex.GetType().Name}: {ex.Message}");
                result.Errors.Add($"Unexpected import failure at {sourceUrl}; its commit state is unknown and it was not replayed.");
                return result;
            }
        }

        private static string? UserCollectionIdentity(JsonElement item)
        {
            return item.ValueKind == JsonValueKind.Object
                && item.TryGetProperty("id", out var id)
                && TryReadPositiveSeerrUserId(id, out var parsedId)
                    ? parsedId.ToString(CultureInfo.InvariantCulture)
                    : null;
        }

        internal static bool TryCollectMappedUserIds(
            SeerrMultiSourceCollectionResult snapshots,
            out HashSet<string> mappedUserIds,
            out string failureReason)
        {
            mappedUserIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            failureReason = string.Empty;

            foreach (var snapshot in snapshots.Sources)
            {
                if (!snapshot.IsComplete || string.IsNullOrWhiteSpace(snapshot.SourceUrl))
                {
                    failureReason = "A configured identity domain did not provide a complete source-bound user map.";
                    return false;
                }

                // A Jellyfin user may intentionally be linked on multiple
                // distinct identity domains; that makes it mapped everywhere
                // for import purposes, not ambiguous. Ambiguity is scoped to
                // one domain, where two Seerr accounts cannot both own the same
                // Jellyfin id (and one Seerr account cannot claim two ids).
                var seerrUserByJellyfinUserId = new Dictionary<string, int>(
                    StringComparer.OrdinalIgnoreCase);
                var jellyfinUserBySeerrUserId = new Dictionary<int, string>();
                foreach (var row in snapshot.Items)
                {
                    if (row.ValueKind != JsonValueKind.Object
                        || !row.TryGetProperty("id", out var id)
                        || !TryReadPositiveSeerrUserId(id, out var seerrUserId))
                    {
                        failureReason = "A Seerr user row did not contain a positive user id.";
                        return false;
                    }

                    if (!row.TryGetProperty("jellyfinUserId", out var jellyfinUserId)
                        || jellyfinUserId.ValueKind == JsonValueKind.Null)
                    {
                        continue;
                    }

                    if (jellyfinUserId.ValueKind != JsonValueKind.String)
                    {
                        failureReason = "A Seerr user row contained a malformed Jellyfin user id.";
                        return false;
                    }

                    var rawJellyfinUserId = jellyfinUserId.GetString();
                    if (string.IsNullOrWhiteSpace(rawJellyfinUserId))
                    {
                        continue;
                    }


                    var normalizedJellyfinUserId = SeerrPaginationHelper.CanonicalJellyfinUserIdentity(
                        rawJellyfinUserId);
                    if (normalizedJellyfinUserId == null)
                    {
                        failureReason = "A Seerr user row contained a malformed Jellyfin user id.";
                        return false;
                    }

                    if (seerrUserByJellyfinUserId.TryGetValue(
                            normalizedJellyfinUserId,
                            out var existingSeerrUserId)
                        && existingSeerrUserId != seerrUserId)
                    {
                        failureReason = "A Jellyfin user had ambiguous ownership within one staged Seerr user map.";
                        return false;
                    }

                    if (jellyfinUserBySeerrUserId.TryGetValue(
                            seerrUserId,
                            out var existingJellyfinUserId)
                        && !string.Equals(
                            existingJellyfinUserId,
                            normalizedJellyfinUserId,
                            StringComparison.OrdinalIgnoreCase))
                    {
                        failureReason = "A Seerr user had ambiguous Jellyfin ownership within one staged user map.";
                        return false;
                    }

                    seerrUserByJellyfinUserId[normalizedJellyfinUserId] = seerrUserId;
                    jellyfinUserBySeerrUserId[seerrUserId] = normalizedJellyfinUserId;
                    mappedUserIds.Add(normalizedJellyfinUserId);
                }
            }

            return true;
        }

        private static bool UserMapsMatch(
            SeerrMultiSourceCollectionResult first,
            SeerrMultiSourceCollectionResult second)
        {
            if (first.Sources.Count != second.Sources.Count) return false;
            for (var sourceIndex = 0; sourceIndex < first.Sources.Count; sourceIndex++)
            {
                var firstSource = first.Sources[sourceIndex];
                var secondSource = second.Sources[sourceIndex];
                if (!string.Equals(firstSource.SourceUrl, secondSource.SourceUrl, StringComparison.Ordinal)
                    || firstSource.Items.Count != secondSource.Items.Count)
                {
                    return false;
                }

                for (var rowIndex = 0; rowIndex < firstSource.Items.Count; rowIndex++)
                {
                    if (!string.Equals(
                            firstSource.Items[rowIndex].GetRawText(),
                            secondSource.Items[rowIndex].GetRawText(),
                            StringComparison.Ordinal))
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        private static bool TryReadPositiveSeerrUserId(JsonElement value, out int id)
        {
            id = 0;
            return value.ValueKind switch
            {
                JsonValueKind.Number => value.TryGetInt32(out id) && id > 0,
                JsonValueKind.String => int.TryParse(
                    value.GetString(),
                    NumberStyles.Integer,
                    CultureInfo.InvariantCulture,
                    out id) && id > 0,
                _ => false,
            };
        }
    }
}
