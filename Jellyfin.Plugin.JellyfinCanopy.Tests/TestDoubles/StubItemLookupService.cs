using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using MediaBrowser.Controller.Entities;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

/// <summary>
/// Minimal configurable item-lookup fake. Provider lookups are empty; direct
/// Jellyfin-id access checks allow every supplied id unless a projection is
/// provided by the test.
/// </summary>
public sealed class StubItemLookupService : IItemLookupService
{
    private readonly Func<
        IReadOnlyCollection<Guid>,
        User,
        IReadOnlySet<Guid>> _accessProjection;
    private readonly Func<
        IReadOnlyCollection<(string Provider, string Value)>,
        Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>> _candidateProjection;

    public StubItemLookupService(
        Func<IReadOnlyCollection<Guid>, User, IReadOnlySet<Guid>>? accessProjection = null,
        Func<
            IReadOnlyCollection<(string Provider, string Value)>,
            Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>>? candidateProjection = null)
    {
        _accessProjection = accessProjection
            ?? ((itemIds, _) => itemIds.ToHashSet());
        _candidateProjection = candidateProjection ?? (_ => new());
    }

    public int AccessQueryCount { get; private set; }

    public List<IReadOnlyList<Guid>> AccessQueryItemIds { get; } = new();

    public int ProviderQueryCount { get; private set; }

    public Action<int>? BeforeAccessQuery { get; set; }

    public static StubItemLookupService FromItems(
        IEnumerable<BaseItem> items,
        Func<IReadOnlyCollection<Guid>, User, IReadOnlySet<Guid>>? accessProjection = null)
    {
        var itemSnapshot = items.ToList();
        return new StubItemLookupService(
            accessProjection,
            providers => ItemLookupService.MapProviderPairs(
                itemSnapshot,
                ItemLookupService.NormalizePairs(providers)));
    }

    public IReadOnlyList<Guid> GetItemIdsByProviders(
        IDictionary<string, string>? providers,
        User? user = null)
        => Array.Empty<Guid>();

    public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
        GetItemCandidatesByProvidersBatch(
            IReadOnlyCollection<(string Provider, string Value)> providers)
    {
        ProviderQueryCount++;
        return _candidateProjection(providers);
    }

    public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
        IReadOnlyCollection<(string Provider, string Value)> providers,
        int maxProviderPairs,
        int maxCandidates)
    {
        ProviderQueryCount++;
        if (providers.Count > maxProviderPairs)
        {
            return new(new(), false);
        }

        var candidates = _candidateProjection(providers);
        return candidates.Values.Sum(static matches => matches.Count) > maxCandidates
            ? new(new(), false)
            : new(candidates, true);
    }

    public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
        IReadOnlyCollection<Guid> itemIds,
        User user)
    {
        AccessQueryCount++;
        AccessQueryItemIds.Add(itemIds.ToArray());
        BeforeAccessQuery?.Invoke(AccessQueryCount);
        return _accessProjection(itemIds, user);
    }
}
