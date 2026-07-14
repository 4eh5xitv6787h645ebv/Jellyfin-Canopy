using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net.Http;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    /// <summary>
    /// Result of an authoritative Seerr collection read. Partial rows are never
    /// exposed: callers either receive one complete, source-identity-unique snapshot from
    /// a single configured base URL, or an explicit incomplete result.
    /// </summary>
    public sealed class SeerrPagedCollectionResult
    {
        internal SeerrPagedCollectionResult(
            bool isComplete,
            IReadOnlyList<JsonElement> items,
            string? sourceUrl,
            SeerrError? error,
            string? failureReason)
        {
            IsComplete = isComplete;
            Items = items;
            SourceUrl = sourceUrl;
            Error = error;
            FailureReason = failureReason;
        }

        public bool IsComplete { get; }

        public IReadOnlyList<JsonElement> Items { get; }

        public string? SourceUrl { get; }

        public SeerrError? Error { get; }

        public string? FailureReason { get; }
    }

    /// <summary>
    /// Result of independently reading the same collection from every configured
    /// Seerr identity domain. A failed domain invalidates the whole aggregate;
    /// successful snapshots from earlier domains are not exposed in that case.
    /// </summary>
    internal sealed class SeerrMultiSourceCollectionResult
    {
        internal SeerrMultiSourceCollectionResult(
            bool isComplete,
            IReadOnlyList<SeerrPagedCollectionResult> sources,
            string? failedSourceUrl,
            SeerrError? error,
            string? failureReason)
        {
            IsComplete = isComplete;
            Sources = sources;
            FailedSourceUrl = failedSourceUrl;
            Error = error;
            FailureReason = failureReason;
        }

        public bool IsComplete { get; }

        public IReadOnlyList<SeerrPagedCollectionResult> Sources { get; }

        public string? FailedSourceUrl { get; }

        public SeerrError? Error { get; }

        public string? FailureReason { get; }
    }

    /// <summary>
    /// Reads Seerr collection endpoints using their reported pagination contract.
    /// A configured URL is attempted from page one through completion; if any page
    /// fails, that partial snapshot is discarded before the next URL is tried.
    /// </summary>
    public static class SeerrPaginationHelper
    {
        public const int DefaultMaximumPages = 1000;
        public const int DefaultMaximumItems = 100000;

        /// <summary>
        /// Projects a positive integer-backed Seerr identity into one stable
        /// key. Some versions/proxies serialize IDs as strings; canonicalizing
        /// them closes aliases such as <c>"01"</c> versus <c>1</c>. Invalid,
        /// non-positive, and out-of-range IDs fail the collection at the
        /// pagination boundary instead of relying on every consumer to repeat
        /// the same validation.
        /// </summary>
        internal static string? CanonicalPositiveIntegerIdentity(JsonElement value)
        {
            if (value.ValueKind == JsonValueKind.Number)
            {
                return value.TryGetInt32(out var numericId) && numericId > 0
                    ? numericId.ToString(CultureInfo.InvariantCulture)
                    : null;
            }

            if (value.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            var text = value.GetString();
            if (text == null) return null;
            return int.TryParse(
                    text,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var stringId)
                && stringId > 0
                ? stringId.ToString(CultureInfo.InvariantCulture)
                : null;
        }

        internal static string? CanonicalPositiveIntegerPropertyIdentity(
            JsonElement owner,
            string propertyName)
            => owner.ValueKind == JsonValueKind.Object
                && owner.TryGetProperty(propertyName, out var value)
                    ? CanonicalPositiveIntegerIdentity(value)
                    : null;

        /// <summary>
        /// Canonicalizes a Jellyfin user identity as a 32-character GUID. A
        /// linked Seerr row with a non-empty non-GUID value is malformed rather
        /// than a separate identity domain.
        /// </summary>
        internal static string? CanonicalJellyfinUserIdentity(string? value)
            => !string.IsNullOrWhiteSpace(value)
                && Guid.TryParse(value.Trim(), out var parsed)
                    ? parsed.ToString("N")
                    : null;

        /// <summary>
        /// Reads one complete, stable snapshot from every distinct configured
        /// source. Unlike <see cref="FetchAllAsync"/>, sources are identity
        /// domains rather than failover replicas, so rows and ids are never
        /// deduplicated across them.
        /// </summary>
        internal static async Task<SeerrMultiSourceCollectionResult> FetchAllSourcesAsync(
            HttpClient httpClient,
            IEnumerable<string> baseUrls,
            Func<string, int, int, string> buildRequestUri,
            string apiKey,
            string? apiUserId,
            int requestedPageSize,
            Func<JsonElement, string?> identitySelector,
            CancellationToken cancellationToken = default,
            int maximumPages = DefaultMaximumPages,
            int maximumItems = DefaultMaximumItems)
        {
            ArgumentNullException.ThrowIfNull(httpClient);
            ArgumentNullException.ThrowIfNull(baseUrls);
            ArgumentNullException.ThrowIfNull(buildRequestUri);
            ArgumentNullException.ThrowIfNull(identitySelector);
            if (requestedPageSize <= 0) throw new ArgumentOutOfRangeException(nameof(requestedPageSize));
            if (maximumPages <= 0) throw new ArgumentOutOfRangeException(nameof(maximumPages));
            if (maximumItems <= 0) throw new ArgumentOutOfRangeException(nameof(maximumItems));

            var sources = baseUrls
                .Select(SeerrUrlIdentity.Normalize)
                .Where(static url => url != null)
                .Select(static url => url!)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (sources.Length == 0)
            {
                return new SeerrMultiSourceCollectionResult(
                    isComplete: false,
                    Array.Empty<SeerrPagedCollectionResult>(),
                    failedSourceUrl: null,
                    error: null,
                    failureReason: "No configured Seerr URL was available.");
            }

            var snapshots = new List<SeerrPagedCollectionResult>(sources.Length);
            foreach (var source in sources)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var snapshot = await FetchAllAsync(
                    httpClient,
                    new[] { source },
                    buildRequestUri,
                    apiKey,
                    apiUserId,
                    requestedPageSize,
                    identitySelector,
                    cancellationToken,
                    maximumPages,
                    maximumItems).ConfigureAwait(false);
                if (!snapshot.IsComplete
                    || !string.Equals(snapshot.SourceUrl, source, StringComparison.Ordinal))
                {
                    return new SeerrMultiSourceCollectionResult(
                        isComplete: false,
                        Array.Empty<SeerrPagedCollectionResult>(),
                        snapshot.SourceUrl ?? source,
                        snapshot.Error,
                        snapshot.FailureReason ?? "The source did not produce a complete collection.");
                }

                snapshots.Add(snapshot);
            }

            return new SeerrMultiSourceCollectionResult(
                isComplete: true,
                snapshots,
                failedSourceUrl: null,
                error: null,
                failureReason: null);
        }

        public static async Task<SeerrPagedCollectionResult> FetchAllAsync(
            HttpClient httpClient,
            IEnumerable<string> baseUrls,
            Func<string, int, int, string> buildRequestUri,
            string apiKey,
            string? apiUserId,
            int requestedPageSize,
            Func<JsonElement, string?> identitySelector,
            CancellationToken cancellationToken = default,
            int maximumPages = DefaultMaximumPages,
            int maximumItems = DefaultMaximumItems)
        {
            ArgumentNullException.ThrowIfNull(httpClient);
            ArgumentNullException.ThrowIfNull(baseUrls);
            ArgumentNullException.ThrowIfNull(buildRequestUri);
            ArgumentNullException.ThrowIfNull(identitySelector);
            if (requestedPageSize <= 0) throw new ArgumentOutOfRangeException(nameof(requestedPageSize));
            if (maximumPages <= 0) throw new ArgumentOutOfRangeException(nameof(maximumPages));
            if (maximumItems <= 0) throw new ArgumentOutOfRangeException(nameof(maximumItems));

            SeerrError? lastError = null;
            string? lastFailure = null;
            string? lastUrl = null;

            var normalizedBaseUrls = baseUrls
                .Select(SeerrUrlIdentity.Normalize)
                .Where(static url => url != null)
                .Select(static url => url!)
                .Distinct(StringComparer.Ordinal);
            foreach (var baseUrl in normalizedBaseUrls)
            {
                cancellationToken.ThrowIfCancellationRequested();

                var firstPass = await FetchFromOneUrlAsync(
                    httpClient,
                    baseUrl,
                    buildRequestUri,
                    apiKey,
                    apiUserId,
                    requestedPageSize,
                    identitySelector,
                    cancellationToken,
                    maximumPages,
                    maximumItems).ConfigureAwait(false);

                if (!firstPass.IsComplete)
                {
                    lastError = firstPass.Error;
                    lastFailure = firstPass.FailureReason;
                    lastUrl = baseUrl;
                    continue;
                }

                // Offset pagination cannot prove a stable snapshot from one
                // pass: deleting an already-read row and inserting a later row
                // can keep the reported total unchanged while shifting an
                // unseen row behind the next offset. Publish only after a
                // consecutive complete pass returns the identical ordered row
                // fingerprints.
                var secondPass = await FetchFromOneUrlAsync(
                    httpClient,
                    baseUrl,
                    buildRequestUri,
                    apiKey,
                    apiUserId,
                    requestedPageSize,
                    identitySelector,
                    cancellationToken,
                    maximumPages,
                    maximumItems).ConfigureAwait(false);

                if (!secondPass.IsComplete)
                {
                    lastError = secondPass.Error;
                    lastFailure = secondPass.FailureReason;
                    lastUrl = baseUrl;
                    continue;
                }

                if (!SnapshotsMatch(firstPass.Items, secondPass.Items))
                {
                    lastError = null;
                    lastFailure = "Two consecutive complete pagination scans disagreed; the collection changed during the read.";
                    lastUrl = baseUrl;
                    continue;
                }

                return secondPass;
            }

            return new SeerrPagedCollectionResult(
                isComplete: false,
                Array.Empty<JsonElement>(),
                lastUrl,
                lastError,
                lastFailure ?? "No configured Seerr URL produced a complete collection.");
        }

        private static bool SnapshotsMatch(
            IReadOnlyList<JsonElement> first,
            IReadOnlyList<JsonElement> second)
        {
            if (first.Count != second.Count) return false;
            for (var index = 0; index < first.Count; index++)
            {
                if (!string.Equals(
                        first[index].GetRawText(),
                        second[index].GetRawText(),
                        StringComparison.Ordinal))
                {
                    return false;
                }
            }

            return true;
        }

        private static async Task<SeerrPagedCollectionResult> FetchFromOneUrlAsync(
            HttpClient httpClient,
            string baseUrl,
            Func<string, int, int, string> buildRequestUri,
            string apiKey,
            string? apiUserId,
            int requestedPageSize,
            Func<JsonElement, string?> identitySelector,
            CancellationToken cancellationToken,
            int maximumPages,
            int maximumItems)
        {
            var items = new List<JsonElement>();
            var identities = new HashSet<string>(StringComparer.Ordinal);
            var identityRows = new Dictionary<string, string>(StringComparer.Ordinal);
            var pageFingerprints = new HashSet<string>(StringComparer.Ordinal);
            int page = 1;
            int skip = 0;
            int rawItemsRead = 0;
            int? expectedTotalPages = null;
            int? expectedTotalResults = null;
            int? previousReportedPage = null;

            while (page <= maximumPages)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var requestUri = buildRequestUri(baseUrl, page, skip);
                SeerrError? responseError = null;
                string? json = null;
                try
                {
                    using var request = SeerrHttpHelper.BuildRequest(
                        HttpMethod.Get,
                        requestUri,
                        apiKey,
                        apiUserId);
                    using var response = await httpClient.SendAsync(request, cancellationToken).ConfigureAwait(false);
                    (json, responseError) = await SeerrHttpHelper.ReadResponseAsync(
                        response,
                        requestUri,
                        cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    return Incomplete(baseUrl, $"Page {page} request failed: {ex.Message}");
                }

                if (responseError != null || string.IsNullOrEmpty(json))
                {
                    return new SeerrPagedCollectionResult(
                        isComplete: false,
                        Array.Empty<JsonElement>(),
                        baseUrl,
                        responseError,
                        $"Page {page} did not return a usable JSON response.");
                }

                cancellationToken.ThrowIfCancellationRequested();

                JsonElement root;
                try
                {
                    root = JsonSerializer.Deserialize<JsonElement>(json);
                }
                catch (JsonException ex)
                {
                    return Incomplete(baseUrl, $"Page {page} returned malformed JSON: {ex.Message}");
                }

                if (root.ValueKind != JsonValueKind.Object)
                {
                    return Incomplete(baseUrl, $"Page {page} JSON root was not an object.");
                }

                if (!root.TryGetProperty("results", out var results)
                    || results.ValueKind != JsonValueKind.Array)
                {
                    return Incomplete(baseUrl, $"Page {page} did not contain a results array.");
                }

                if (!TryReadPagination(
                        root,
                        out var reportedPage,
                        out var totalPages,
                        out var totalResults,
                        out var metadataFailure))
                {
                    return Incomplete(baseUrl, $"Page {page} pagination is invalid: {metadataFailure}");
                }

                if (totalPages.HasValue)
                {
                    if (expectedTotalPages.HasValue && expectedTotalPages.Value != totalPages.Value)
                    {
                        return Incomplete(baseUrl, "Pagination totalPages changed during one collection read.");
                    }

                    expectedTotalPages = totalPages;
                }

                if (totalResults.HasValue)
                {
                    if (expectedTotalResults.HasValue && expectedTotalResults.Value != totalResults.Value)
                    {
                        return Incomplete(baseUrl, "Pagination totalResults changed during one collection read.");
                    }

                    expectedTotalResults = totalResults;
                }

                if (expectedTotalPages.HasValue && expectedTotalPages.Value > maximumPages)
                {
                    return Incomplete(baseUrl, $"Pagination exceeded the {maximumPages} page safety bound.");
                }

                if (expectedTotalResults.HasValue && expectedTotalResults.Value > maximumItems)
                {
                    return Incomplete(baseUrl, $"Pagination exceeded the {maximumItems} item safety bound.");
                }

                if (expectedTotalPages.HasValue
                    && expectedTotalPages.Value > 0
                    && page > expectedTotalPages.Value)
                {
                    return Incomplete(
                        baseUrl,
                        $"Pagination requested page {page} beyond totalPages {expectedTotalPages.Value}.");
                }

                if (reportedPage.HasValue)
                {
                    if (reportedPage.Value != page)
                    {
                        return Incomplete(
                            baseUrl,
                            $"Pagination reported page {reportedPage.Value} while page {page} was requested.");
                    }

                    if (expectedTotalPages.HasValue
                        && expectedTotalPages.Value > 0
                        && reportedPage.Value > expectedTotalPages.Value)
                    {
                        return Incomplete(
                            baseUrl,
                            $"Pagination reported page {reportedPage.Value} beyond totalPages {expectedTotalPages.Value}.");
                    }

                    if (previousReportedPage.HasValue && reportedPage.Value <= previousReportedPage.Value)
                    {
                        return Incomplete(baseUrl, "Pagination page metadata did not advance.");
                    }

                    previousReportedPage = reportedPage;
                }

                var pageRows = results.EnumerateArray().Select(static item => item.Clone()).ToArray();
                cancellationToken.ThrowIfCancellationRequested();
                var fingerprint = string.Join("\u001f", pageRows.Select(static item => item.GetRawText()));
                if (pageRows.Length > 0 && !pageFingerprints.Add(fingerprint))
                {
                    return Incomplete(baseUrl, "Pagination repeated a previously returned page.");
                }

                if (pageRows.Length == 0 && rawItemsRead > 0)
                {
                    return Incomplete(baseUrl, "Pagination returned an empty page after collection rows.");
                }

                rawItemsRead += pageRows.Length;
                if (rawItemsRead > maximumItems)
                {
                    return Incomplete(baseUrl, $"Pagination exceeded the {maximumItems} item safety bound.");
                }

                if (expectedTotalResults.HasValue && rawItemsRead > expectedTotalResults.Value)
                {
                    return Incomplete(baseUrl, "Pagination returned more rows than totalResults.");
                }

                if (expectedTotalPages == 0 && pageRows.Length > 0)
                {
                    return Incomplete(baseUrl, "Pagination reported zero pages but returned collection rows.");
                }

                if (expectedTotalResults == 0 && pageRows.Length > 0)
                {
                    return Incomplete(baseUrl, "Pagination reported zero results but returned collection rows.");
                }

                var itemCountBeforePage = items.Count;
                foreach (var item in pageRows)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    string? identity;
                    try
                    {
                        identity = identitySelector(item);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        return Incomplete(
                            baseUrl,
                            $"Pagination row identity projection failed on page {page}: {ex.Message}");
                    }

                    cancellationToken.ThrowIfCancellationRequested();

                    if (string.IsNullOrWhiteSpace(identity))
                    {
                        return Incomplete(
                            baseUrl,
                            $"Pagination row identity was missing or empty on page {page}.");
                    }

                    var rowFingerprint = item.GetRawText();
                    if (!identities.Add(identity))
                    {
                        if (identityRows.TryGetValue(identity, out var existing)
                            && !string.Equals(existing, rowFingerprint, StringComparison.Ordinal))
                        {
                            return Incomplete(
                                baseUrl,
                                $"Pagination identity '{identity}' referred to conflicting rows.");
                        }

                        // The supported Seerr/Jellyfin endpoints page unique
                        // primary-key rows. Any repeated source identity means
                        // the response is malformed or the offset snapshot
                        // moved between reads. De-duplicating it would let raw
                        // row counts reach totalResults while omitting a row.
                        return Incomplete(
                            baseUrl,
                            $"Pagination identity '{identity}' was repeated in one collection read.");
                    }

                    identityRows[identity] = rowFingerprint;
                    items.Add(item);
                }

                if (page > 1 && pageRows.Length > 0 && items.Count == itemCountBeforePage)
                {
                    return Incomplete(baseUrl, "Pagination continuation page made no identity progress.");
                }

                // Every supplied completion signal must agree. Accepting the
                // first one independently can truncate when, for example,
                // totalPages says 1 but totalResults describes more rows.
                var completeByPages = !expectedTotalPages.HasValue
                    || expectedTotalPages.Value == 0
                    || page >= expectedTotalPages.Value;
                var completeByResults = !expectedTotalResults.HasValue
                    || items.Count == expectedTotalResults.Value;
                if (completeByPages && completeByResults)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    return new SeerrPagedCollectionResult(
                        isComplete: true,
                        items,
                        baseUrl,
                        error: null,
                        failureReason: null);
                }

                if (pageRows.Length == 0)
                {
                    return Incomplete(baseUrl, "Pagination returned an empty page before the reported end.");
                }

                skip += pageRows.Length;
                page++;
            }

            return Incomplete(baseUrl, $"Pagination exceeded the {maximumPages} page safety bound.");
        }

        private static bool TryReadPagination(
            JsonElement root,
            out int? page,
            out int? totalPages,
            out int? totalResults,
            out string? failure)
        {
            page = null;
            totalPages = null;
            totalResults = null;
            failure = null;
            if (!TryReadOptionalNonNegativeInt(root, "page", out page, out failure)
                || !TryReadOptionalNonNegativeInt(root, "totalPages", out totalPages, out failure)
                || !TryReadOptionalNonNegativeInt(root, "totalResults", out totalResults, out failure))
            {
                return false;
            }

            if (root.TryGetProperty("pageInfo", out var pageInfo))
            {
                if (pageInfo.ValueKind != JsonValueKind.Object)
                {
                    failure = "pageInfo was not an object";
                    return false;
                }

                if (!TryReadOptionalNonNegativeInt(pageInfo, "page", out var pageInfoPage, out failure)
                    || !TryReadOptionalNonNegativeInt(pageInfo, "pages", out var pageInfoPages, out failure)
                    || !TryReadOptionalNonNegativeInt(pageInfo, "results", out var pageInfoResults, out failure))
                {
                    return false;
                }

                if (!MergePaginationValue("page", ref page, pageInfoPage, out failure)
                    || !MergePaginationValue("total pages", ref totalPages, pageInfoPages, out failure)
                    || !MergePaginationValue("total results", ref totalResults, pageInfoResults, out failure))
                {
                    return false;
                }
            }

            if (!totalPages.HasValue && !totalResults.HasValue)
            {
                failure = "completion metadata was missing";
                return false;
            }

            return true;
        }

        private static bool TryReadOptionalNonNegativeInt(
            JsonElement owner,
            string propertyName,
            out int? number,
            out string? failure)
        {
            number = null;
            failure = null;
            if (!owner.TryGetProperty(propertyName, out var value))
            {
                return true;
            }

            if (value.ValueKind != JsonValueKind.Number
                || !value.TryGetInt32(out var parsed)
                || parsed < 0)
            {
                failure = $"{propertyName} was not a non-negative integer";
                return false;
            }

            number = parsed;
            return true;
        }

        private static bool MergePaginationValue(
            string name,
            ref int? current,
            int? alternate,
            out string? failure)
        {
            failure = null;
            if (!alternate.HasValue)
            {
                return true;
            }

            if (current.HasValue && current.Value != alternate.Value)
            {
                failure = $"top-level and pageInfo {name} values disagreed";
                return false;
            }

            current = alternate;
            return true;
        }

        private static SeerrPagedCollectionResult Incomplete(string sourceUrl, string reason)
            => new(
                isComplete: false,
                Array.Empty<JsonElement>(),
                sourceUrl,
                error: null,
                failureReason: reason);
    }
}
