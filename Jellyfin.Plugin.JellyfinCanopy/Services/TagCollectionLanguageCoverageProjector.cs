using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Builds caller-scoped language coverage from direct manual Movie members of BoxSets.
    /// Instances are request-scoped and never persist user-sensitive membership or counts.
    /// </summary>
    internal sealed class TagCollectionLanguageCoverageProjector
    {
        internal const int PageSize = 500;
        internal const int MaximumMembershipEdgesPerRequest = 20_000;

        private readonly ILibraryManager _libraryManager;
        private readonly TagCacheService _tagCacheService;
        private readonly ILogger _logger;

        internal TagCollectionLanguageCoverageProjector(
            ILibraryManager libraryManager,
            TagCacheService tagCacheService,
            ILogger logger)
        {
            _libraryManager = libraryManager;
            _tagCacheService = tagCacheService;
            _logger = logger;
        }

        internal IReadOnlyDictionary<string, TagCollectionLanguageCoverage> ProjectAccessibleSnapshot(
            JUser user,
            IReadOnlyDictionary<string, TagCacheEntry> items,
            CancellationToken cancellationToken)
        {
            _ = user; // The supplied snapshot has already been filtered for this caller.
            // As with Series/Season coverage, nonzero SourceRevision is the cache's
            // eventual-consistency fence. A queued Movie event becomes visible after the
            // background tag-cache flush; this path does not synchronously re-probe Movies.
            var collectionIds = CollectionIds(items);
            return Project(
                collectionIds,
                memberIds => ResolveSnapshotMembers(memberIds, items),
                cancellationToken);
        }

        internal IReadOnlyDictionary<string, TagCollectionLanguageCoverage> ProjectEntries(
            JUser user,
            IReadOnlyDictionary<string, TagCacheEntry> entries,
            CancellationToken cancellationToken)
            => ProjectLive(user, CollectionIds(entries), cancellationToken);

        internal IReadOnlyDictionary<string, TagCollectionLanguageCoverage> ProjectContainers(
            JUser user,
            IEnumerable<BaseItem> containers,
            CancellationToken cancellationToken)
            => ProjectLive(
                user,
                containers.Where(static item => item.GetBaseItemKind() == BaseItemKind.BoxSet)
                    .Select(static item => item.Id),
                cancellationToken);

        private IReadOnlyDictionary<string, TagCollectionLanguageCoverage> ProjectLive(
            JUser user,
            IEnumerable<Guid> collectionIds,
            CancellationToken cancellationToken)
            => Project(
                collectionIds,
                memberIds => ResolveLiveMembers(user, memberIds, cancellationToken),
                cancellationToken);

        private IReadOnlyDictionary<string, TagCollectionLanguageCoverage> Project(
            IEnumerable<Guid> sourceCollectionIds,
            Func<IReadOnlyCollection<Guid>, IReadOnlyDictionary<Guid, MemberEvidence>> resolveMembers,
            CancellationToken cancellationToken)
        {
            var collectionIds = sourceCollectionIds.Where(static id => id != Guid.Empty)
                .Distinct().OrderBy(static id => id).ToArray();
            var result = new Dictionary<string, TagCollectionLanguageCoverage>(StringComparer.Ordinal);
            var membersByCollection = new Dictionary<Guid, Guid[]>();
            var failed = new HashSet<Guid>();
            var edgeCount = 0;

            foreach (var collectionId in collectionIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    // Jellyfin's relationship API materializes one collection's rows before
                    // returning. We enforce the request-wide cap immediately afterwards and
                    // before any union/member query; the host API offers no streaming overload.
                    var members = _tagCacheService.GetCollectionMemberIds(collectionId).ToArray();
                    if (members.Any(static id => id == Guid.Empty))
                    {
                        throw new InvalidOperationException("Collection membership returned an empty relationship id.");
                    }

                    checked { edgeCount += members.Length; }
                    if (edgeCount > MaximumMembershipEdgesPerRequest)
                    {
                        foreach (var requestedId in collectionIds)
                        {
                            result[Key(requestedId)] = Unknown(truncated: true);
                        }

                        return result;
                    }

                    // Membership is a set contract even if a malformed/legacy database happens
                    // to expose the same manual edge twice.
                    membersByCollection[collectionId] = members.Distinct().ToArray();
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    failed.Add(collectionId);
                    _logger.LogWarning(
                        "[TagCache] Collection language membership failed for {CollectionId}: {Message}",
                        collectionId,
                        ex.Message);
                }
            }

            IReadOnlyDictionary<Guid, MemberEvidence> resolved;
            try
            {
                var memberIds = membersByCollection.Where(pair => !failed.Contains(pair.Key))
                    .SelectMany(static pair => pair.Value).Distinct().ToArray();
                resolved = resolveMembers(memberIds);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[TagCache] Caller-scoped collection member query failed: {Message}", ex.Message);
                foreach (var collectionId in collectionIds)
                {
                    result[Key(collectionId)] = Unknown(truncated: false);
                }

                return result;
            }

            foreach (var collectionId in collectionIds)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (failed.Contains(collectionId))
                {
                    result[Key(collectionId)] = Unknown(truncated: false);
                    continue;
                }

                var evidence = membersByCollection[collectionId]
                    .Where(resolved.ContainsKey)
                    .Select(memberId => resolved[memberId])
                    .Select(static member => member.ProbeSucceeded
                        ? TagLanguageCoverageProjector.LanguageEpisodeEvidence.Observed(member.Languages, member.OriginalLanguage)
                        : TagLanguageCoverageProjector.LanguageEpisodeEvidence.Unknown(member.Languages, member.OriginalLanguage));
                result[Key(collectionId)] = Translate(
                    TagLanguageCoverageProjector.Aggregate(evidence, enumerationComplete: true));
            }

            return result;
        }

        private IReadOnlyDictionary<Guid, MemberEvidence> ResolveLiveMembers(
            JUser user,
            IReadOnlyCollection<Guid> memberIds,
            CancellationToken cancellationToken)
        {
            var live = new Dictionary<Guid, BaseItem>();
            foreach (var batch in memberIds.Chunk(PageSize))
            {
                cancellationToken.ThrowIfCancellationRequested();
                var requested = batch.ToHashSet();
                // ItemIds on InternalItemsQuery bypass Jellyfin's automatic top-parent
                // projection. Configure the caller's access scope before assigning ids.
                var query = Data.UserAccessQuery.BuildItemIds(_libraryManager, user, batch);
                query.IncludeItemTypes = new[] { BaseItemKind.Movie };
                query.IsVirtualItem = false;
                query.Limit = PageSize;
                query.EnableTotalRecordCount = false;
                var page = _libraryManager.GetItemsResult(query);
                if (page.Items.Count > PageSize
                    || page.Items.Any(item => item.GetBaseItemKind() != BaseItemKind.Movie
                        || item.IsVirtualItem
                        || !requested.Contains(item.Id))
                    || page.Items.Select(static item => item.Id).Distinct().Count() != page.Items.Count)
                {
                    throw new InvalidOperationException("Collection member query returned foreign or duplicate rows.");
                }

                foreach (var item in page.Items) live.Add(item.Id, item);
            }

            var cached = _tagCacheService.GetCachedEntriesByIds(live.Keys);
            return live.ToDictionary(
                static pair => pair.Key,
                pair => cached.TryGetValue(pair.Key, out var entry)
                    && string.Equals(entry.Type, nameof(BaseItemKind.Movie), StringComparison.Ordinal)
                    ? Evidence(entry, pair.Value.DateLastSaved.Ticks)
                    : MemberEvidence.Unknown(Array.Empty<string>()));
        }

        private static IReadOnlyDictionary<Guid, MemberEvidence> ResolveSnapshotMembers(
            IReadOnlyCollection<Guid> memberIds,
            IReadOnlyDictionary<string, TagCacheEntry> items)
        {
            var result = new Dictionary<Guid, MemberEvidence>();
            foreach (var memberId in memberIds)
            {
                if (items.TryGetValue(Key(memberId), out var entry)
                    && string.Equals(entry.Type, nameof(BaseItemKind.Movie), StringComparison.Ordinal))
                {
                    result[memberId] = Evidence(entry, currentRevision: null);
                }
            }

            return result;
        }

        private static IEnumerable<Guid> CollectionIds(IReadOnlyDictionary<string, TagCacheEntry> entries)
            => entries.Where(static pair => string.Equals(pair.Value.Type, nameof(BaseItemKind.BoxSet), StringComparison.Ordinal))
                .Select(static pair => Guid.TryParseExact(pair.Key, "N", out var id) ? id : Guid.Empty);

        private static MemberEvidence Evidence(TagCacheEntry entry, long? currentRevision)
        {
            var current = entry.SourceRevision != 0
                && (!currentRevision.HasValue || entry.SourceRevision == currentRevision.Value);
            return current
                ? MemberEvidence.Observed(entry.AudioLanguages ?? Array.Empty<string>(), entry.OriginalLanguage)
                : MemberEvidence.Unknown(entry.AudioLanguages ?? Array.Empty<string>(), entry.OriginalLanguage);
        }

        private static TagCollectionLanguageCoverage Translate(TagLanguageCoverage source)
            => new()
            {
                EligibleMemberCount = source.EligibleEpisodeCount,
                ObservedMemberCount = source.ObservedEpisodeCount,
                Complete = source.Complete,
                FullLanguages = source.FullLanguages,
                PartialLanguages = source.PartialLanguages,
                UnknownLanguages = source.UnknownLanguages,
                OriginalLanguages = source.OriginalLanguages,
                Truncated = source.Truncated,
                OmittedLanguageCount = source.OmittedLanguageCount,
            };

        private static TagCollectionLanguageCoverage Unknown(bool truncated)
            => new() { Complete = false, Truncated = truncated };

        private static string Key(Guid id) => id.ToString("N");

        private readonly record struct MemberEvidence(
            bool ProbeSucceeded,
            string[] Languages,
            string? OriginalLanguage)
        {
            internal static MemberEvidence Observed(string[] languages, string? originalLanguage = null)
                => new(true, languages, originalLanguage);

            internal static MemberEvidence Unknown(string[] languages, string? originalLanguage = null)
                => new(false, languages, originalLanguage);
        }
    }
}
