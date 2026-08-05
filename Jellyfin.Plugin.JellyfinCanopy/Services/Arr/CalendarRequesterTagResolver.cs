using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Querying;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>An allowlisted Calendar media key produced by requester-tag attribution.</summary>
    public readonly record struct CalendarRequesterMediaKey(int TmdbId, string Type);

    /// <summary>
    /// Complete-or-empty result of a requester-tag resolution. An incomplete result never
    /// carries keys, so a caller cannot accidentally publish a bounded prefix.
    /// </summary>
    public sealed class CalendarRequesterTagResolution
    {
        private CalendarRequesterTagResolution(
            bool isComplete,
            IReadOnlyList<CalendarRequesterMediaKey> keys,
            string? failureReason)
        {
            IsComplete = isComplete;
            Keys = keys;
            FailureReason = failureReason;
        }

        public bool IsComplete { get; }

        public IReadOnlyList<CalendarRequesterMediaKey> Keys { get; }

        public string? FailureReason { get; }

        internal static CalendarRequesterTagResolution Complete(
            IReadOnlyList<CalendarRequesterMediaKey> keys)
            => new(true, keys, null);

        internal static CalendarRequesterTagResolution Incomplete(string failureReason)
            => new(false, Array.Empty<CalendarRequesterMediaKey>(), failureReason);
    }

    /// <summary>
    /// Resolves an administrator-owned exact media-tag convention into the authenticated
    /// Jellyfin user's Calendar request keys. The scan is always user-access-scoped,
    /// paginated, bounded, cancellation-aware, and repeated to reject a changing library
    /// projection. Raw tags and mapped user identities never leave this service.
    /// </summary>
    public sealed class CalendarRequesterTagResolver
    {
        internal const int MaxMappingBytes = 64 * 1024;
        internal const int MaxMappingRows = 256;
        internal const int MaxPrefixLength = 32;
        internal const int MaxTokenLength = 64;
        internal const int MaxFullTagLength = MaxPrefixLength + MaxTokenLength;
        internal const int LibraryPageSize = 200;
        internal const int MaxTaggedItems = 5000;
        private const int MaxLibraryPages = (MaxTaggedItems / LibraryPageSize) + 2;

        private readonly ILibraryManager _libraryManager;
        private readonly IUserManager _userManager;

        public CalendarRequesterTagResolver(
            ILibraryManager libraryManager,
            IUserManager userManager)
        {
            _libraryManager = libraryManager;
            _userManager = userManager;
        }

        /// <summary>
        /// Resolves requester tags for <paramref name="user"/>. Disabled fallback is a
        /// complete empty result; invalid global configuration or any incomplete scan is not.
        /// </summary>
        public CalendarRequesterTagResolution Resolve(
            PluginConfiguration configuration,
            JUser user,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            ArgumentNullException.ThrowIfNull(user);
            cancellationToken.ThrowIfCancellationRequested();

            if (!configuration.CalendarRequesterTagFallbackEnabled)
            {
                return CalendarRequesterTagResolution.Complete(
                    Array.Empty<CalendarRequesterMediaKey>());
            }

            if (!TryParseConfiguration(configuration, out var parsed, out var failureReason))
            {
                return CalendarRequesterTagResolution.Incomplete(failureReason);
            }

            if (!MappedUsersExist(parsed!.UserIds, cancellationToken, out failureReason))
            {
                return CalendarRequesterTagResolution.Incomplete(failureReason);
            }

            // An unmapped caller has no fallback claim. Configuration still had to validate
            // every referenced stable id before this could be a complete empty answer.
            if (!parsed.UserIds.Contains(user.Id))
            {
                return CalendarRequesterTagResolution.Complete(
                    Array.Empty<CalendarRequesterMediaKey>());
            }

            var first = ScanOnce(parsed, user, cancellationToken);
            if (!first.IsComplete)
            {
                return CalendarRequesterTagResolution.Incomplete(first.FailureReason!);
            }

            var second = ScanOnce(parsed, user, cancellationToken);
            if (!second.IsComplete)
            {
                return CalendarRequesterTagResolution.Incomplete(second.FailureReason!);
            }

            if (!MappedUsersExist(parsed.UserIds, cancellationToken, out failureReason))
            {
                return CalendarRequesterTagResolution.Incomplete(failureReason);
            }

            if (!Equivalent(first.AttributionByKey!, second.AttributionByKey!))
            {
                return CalendarRequesterTagResolution.Incomplete("library_projection_changed");
            }

            var keys = second.AttributionByKey!
                .Where(entry => entry.Value == user.Id)
                .Select(entry => entry.Key)
                .OrderBy(key => key.Type, StringComparer.Ordinal)
                .ThenBy(key => key.TmdbId)
                .ToArray();
            return CalendarRequesterTagResolution.Complete(keys);
        }

        private bool MappedUsersExist(
            IEnumerable<Guid> mappedUserIds,
            CancellationToken cancellationToken,
            out string failureReason)
        {
            failureReason = string.Empty;
            foreach (var mappedUserId in mappedUserIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                JUser? mappedUser;
                try
                {
                    mappedUser = _userManager.GetUserById(mappedUserId);
                }
                catch
                {
                    failureReason = "mapped_user_lookup_failed";
                    return false;
                }

                if (mappedUser == null || mappedUser.Id != mappedUserId)
                {
                    failureReason = "mapped_user_missing";
                    return false;
                }
            }

            return true;
        }

        internal static bool TryParseConfiguration(
            PluginConfiguration configuration,
            out ParsedRequesterTagConfiguration? parsed,
            out string failureReason)
        {
            parsed = null;
            failureReason = string.Empty;

            var prefix = configuration.CalendarRequesterTagPrefix?.Trim() ?? string.Empty;
            if (!IsValidPrefix(prefix))
            {
                failureReason = "invalid_prefix";
                return false;
            }

            var rawMappings = configuration.CalendarRequesterTagMappings ?? string.Empty;
            if (Encoding.UTF8.GetByteCount(rawMappings) > MaxMappingBytes)
            {
                failureReason = "mapping_bytes_exceeded";
                return false;
            }

            var rows = rawMappings
                .Split(new[] { "\r\n", "\n", "\r" }, StringSplitOptions.None)
                .Where(row => !string.IsNullOrWhiteSpace(row))
                .ToArray();
            if (rows.Length == 0 || rows.Length > MaxMappingRows)
            {
                failureReason = rows.Length == 0 ? "mapping_empty" : "mapping_rows_exceeded";
                return false;
            }

            var tagOwners = new Dictionary<string, Guid>(StringComparer.Ordinal);
            var userTags = new Dictionary<Guid, string>();
            foreach (var rowValue in rows)
            {
                var row = rowValue.Trim();
                var separator = row.IndexOf('=');
                if (separator <= 0
                    || separator != row.LastIndexOf('=')
                    || separator == row.Length - 1)
                {
                    failureReason = "mapping_row_malformed";
                    return false;
                }

                var rawUserId = row[..separator].Trim();
                var token = row[(separator + 1)..].Trim();
                if (!Guid.TryParseExact(rawUserId, "D", out var userId)
                    || !string.Equals(
                        rawUserId,
                        userId.ToString("D", CultureInfo.InvariantCulture),
                        StringComparison.Ordinal)
                    || !IsValidToken(token))
                {
                    failureReason = "mapping_row_invalid";
                    return false;
                }

                var fullTag = prefix + token;
                if (fullTag.Length > MaxFullTagLength
                    || userTags.ContainsKey(userId)
                    || tagOwners.ContainsKey(fullTag))
                {
                    failureReason = "mapping_collision";
                    return false;
                }

                userTags.Add(userId, fullTag);
                tagOwners.Add(fullTag, userId);
            }

            parsed = new ParsedRequesterTagConfiguration(prefix, tagOwners, userTags.Keys.ToHashSet());
            return true;
        }

        private ScanResult ScanOnce(
            ParsedRequesterTagConfiguration parsed,
            JUser user,
            CancellationToken cancellationToken)
        {
            var candidateKeys = new HashSet<CalendarRequesterMediaKey>();
            var candidateFailure = ScanItems(
                user,
                query => query.Tags = parsed.TagOwners.Keys.ToArray(),
                item =>
                {
                    if (TryGetMediaKey(item, out var key)
                        && (item.Tags ?? Array.Empty<string>())
                            .Any(tag => tag != null && parsed.TagOwners.ContainsKey(tag)))
                    {
                        candidateKeys.Add(key);
                    }
                },
                cancellationToken);
            if (candidateFailure != null)
            {
                return ScanResult.Incomplete(candidateFailure);
            }

            if (candidateKeys.Count == 0)
            {
                return ScanResult.Complete(
                    new Dictionary<CalendarRequesterMediaKey, Guid?>());
            }

            // The exact-tag query above identifies bounded candidate media keys, but it
            // cannot see another edition that carries only an unmapped, malformed, or
            // case-confusable reserved tag. Expand those TMDB ids through the same caller
            // access projection and inspect every edition before assigning an owner.
            var candidateTmdbIds = candidateKeys
                .Select(key => key.TmdbId.ToString(CultureInfo.InvariantCulture))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray();
            var attributionByKey = new Dictionary<CalendarRequesterMediaKey, Guid?>();
            var editionFailure = ScanItems(
                user,
                query => query.HasAnyProviderIds = new Dictionary<string, string[]>(
                    StringComparer.Ordinal)
                {
                    ["Tmdb"] = candidateTmdbIds,
                },
                item => ProjectItem(parsed, candidateKeys, item, attributionByKey),
                cancellationToken);
            return editionFailure == null
                ? ScanResult.Complete(attributionByKey)
                : ScanResult.Incomplete(editionFailure);
        }

        private string? ScanItems(
            JUser user,
            Action<InternalItemsQuery> addRestrictiveFilter,
            Action<BaseItem> projectItem,
            CancellationToken cancellationToken)
        {
            var seenItemIds = new HashSet<Guid>();
            var startIndex = 0;
            var expectedTotal = -1;

            for (var pageNumber = 0; pageNumber < MaxLibraryPages; pageNumber++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var query = new InternalItemsQuery(user)
                {
                    IncludeItemTypes = new[] { BaseItemKind.Movie, BaseItemKind.Series },
                    Recursive = true,
                    StartIndex = startIndex,
                    Limit = LibraryPageSize,
                    EnableTotalRecordCount = true,
                    OrderBy = new[] { (ItemSortBy.SortName, JSortOrder.Ascending) },
                    GroupByPresentationUniqueKey = false,
                    IncludeOwnedItems = true,
                    DtoOptions = new DtoOptions(false)
                    {
                        Fields = new[] { ItemFields.ProviderIds, ItemFields.Tags },
                        EnableImages = false,
                        EnableUserData = false,
                        AddCurrentProgram = false,
                    },
                };

                // Jellyfin skips its top-parent projection when restrictive fields are already
                // populated. Configure user access first, then add the caller-owned filter.
                try
                {
                    _libraryManager.ConfigureUserAccess(query, user);
                    addRestrictiveFilter(query);
                    cancellationToken.ThrowIfCancellationRequested();
                    var page = _libraryManager.GetItemsResult(query);
                    cancellationToken.ThrowIfCancellationRequested();

                    if (expectedTotal < 0)
                    {
                        expectedTotal = page.TotalRecordCount;
                    }
                    else if (expectedTotal != page.TotalRecordCount)
                    {
                        return "library_total_changed";
                    }

                    if (expectedTotal < 0 || expectedTotal > MaxTaggedItems)
                    {
                        return "library_item_bound_exceeded";
                    }

                    if (page.Items.Count > LibraryPageSize)
                    {
                        return "library_page_oversized";
                    }

                    foreach (var item in page.Items)
                    {
                        cancellationToken.ThrowIfCancellationRequested();
                        if (item == null || !seenItemIds.Add(item.Id))
                        {
                            return "library_item_duplicate";
                        }

                        projectItem(item);
                    }

                    startIndex += page.Items.Count;
                    if (startIndex > MaxTaggedItems)
                    {
                        return "library_item_bound_exceeded";
                    }

                    if (startIndex == expectedTotal)
                    {
                        return null;
                    }

                    if (page.Items.Count == 0
                        || page.Items.Count < LibraryPageSize
                        || startIndex > expectedTotal)
                    {
                        return "library_pagination_incomplete";
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch
                {
                    return "library_query_failed";
                }
            }

            return "library_page_bound_exceeded";
        }

        private static void ProjectItem(
            ParsedRequesterTagConfiguration parsed,
            IReadOnlySet<CalendarRequesterMediaKey> candidateKeys,
            BaseItem item,
            IDictionary<CalendarRequesterMediaKey, Guid?> attributionByKey)
        {
            if (!TryGetMediaKey(item, out var key) || !candidateKeys.Contains(key))
            {
                return;
            }

            var requesterTags = (item.Tags ?? Array.Empty<string>())
                .Where(tag => tag?.StartsWith(parsed.Prefix, StringComparison.OrdinalIgnoreCase) == true)
                .ToArray();

            // An untagged alternate edition is neutral. Any edition that enters the
            // reserved namespace must resolve to exactly one configured owner.
            if (requesterTags.Length == 0)
            {
                return;
            }

            if (requesterTags.Length != 1
                || requesterTags[0].Length > MaxFullTagLength
                || !requesterTags[0].StartsWith(parsed.Prefix, StringComparison.Ordinal)
                || !parsed.TagOwners.TryGetValue(requesterTags[0], out var ownerId))
            {
                attributionByKey[key] = null;
                return;
            }

            if (!attributionByKey.TryGetValue(key, out var existingOwner))
            {
                attributionByKey.Add(key, ownerId);
                return;
            }

            if (existingOwner != ownerId)
            {
                attributionByKey[key] = null;
            }
        }

        private static bool TryGetMediaKey(
            BaseItem item,
            out CalendarRequesterMediaKey key)
        {
            key = default;
            var type = item switch
            {
                Movie => "movie",
                Series => "tv",
                _ => null,
            };
            if (type == null
                || !item.ProviderIds.TryGetValue("Tmdb", out var rawTmdbId)
                || !int.TryParse(rawTmdbId, NumberStyles.None, CultureInfo.InvariantCulture, out var tmdbId)
                || tmdbId <= 0)
            {
                return false;
            }

            key = new CalendarRequesterMediaKey(tmdbId, type);
            return true;
        }

        private static bool Equivalent(
            IReadOnlyDictionary<CalendarRequesterMediaKey, Guid?> first,
            IReadOnlyDictionary<CalendarRequesterMediaKey, Guid?> second)
            => first.Count == second.Count
                && first.All(entry => second.TryGetValue(entry.Key, out var owner)
                    && owner == entry.Value);

        private static bool IsValidPrefix(string value)
        {
            if (value.Length < 2
                || value.Length > MaxPrefixLength
                || value[^1] != ':'
                || value[0] is < 'a' or > 'z')
            {
                return false;
            }

            for (var i = 0; i < value.Length - 1; i++)
            {
                var ch = value[i];
                if ((ch is >= 'a' and <= 'z')
                    || (ch is >= '0' and <= '9')
                    || ch is '.' or '_' or '-')
                {
                    continue;
                }

                return false;
            }

            return true;
        }

        private static bool IsValidToken(string value)
        {
            if (value.Length == 0
                || value.Length > MaxTokenLength
                || !IsAsciiAlphaNumeric(value[0]))
            {
                return false;
            }

            foreach (var ch in value)
            {
                if (IsAsciiAlphaNumeric(ch) || ch is '.' or '_' or '-')
                {
                    continue;
                }

                return false;
            }

            return true;
        }

        private static bool IsAsciiAlphaNumeric(char value)
            => value is >= 'a' and <= 'z' or >= '0' and <= '9';

        internal sealed record ParsedRequesterTagConfiguration(
            string Prefix,
            IReadOnlyDictionary<string, Guid> TagOwners,
            IReadOnlySet<Guid> UserIds);

        private sealed class ScanResult
        {
            private ScanResult(
                bool isComplete,
                IReadOnlyDictionary<CalendarRequesterMediaKey, Guid?>? attributionByKey,
                string? failureReason)
            {
                IsComplete = isComplete;
                AttributionByKey = attributionByKey;
                FailureReason = failureReason;
            }

            public bool IsComplete { get; }

            public IReadOnlyDictionary<CalendarRequesterMediaKey, Guid?>? AttributionByKey { get; }

            public string? FailureReason { get; }

            public static ScanResult Complete(
                IReadOnlyDictionary<CalendarRequesterMediaKey, Guid?> attributionByKey)
                => new(true, attributionByKey, null);

            public static ScanResult Incomplete(string failureReason)
                => new(false, null, failureReason);
        }
    }
}
