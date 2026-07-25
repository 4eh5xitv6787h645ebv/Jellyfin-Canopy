using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Data;

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

    public StubItemLookupService(
        Func<IReadOnlyCollection<Guid>, User, IReadOnlySet<Guid>>? accessProjection = null)
    {
        _accessProjection = accessProjection
            ?? ((itemIds, _) => itemIds.ToHashSet());
    }

    public int AccessQueryCount { get; private set; }

    public IReadOnlyList<Guid> GetItemIdsByProviders(
        IDictionary<string, string>? providers,
        User? user = null)
        => Array.Empty<Guid>();

    public Dictionary<(string Provider, string Value), IReadOnlyList<ItemLookupCandidate>>
        GetItemCandidatesByProvidersBatch(
            IReadOnlyCollection<(string Provider, string Value)> providers)
        => new();

    public ItemLookupBatchResult GetItemCandidatesByProvidersBatchBounded(
        IReadOnlyCollection<(string Provider, string Value)> providers,
        int maxProviderPairs,
        int maxCandidates)
        => new(new(), true);

    public IReadOnlySet<Guid> GetAccessibleItemIdsBatch(
        IReadOnlyCollection<Guid> itemIds,
        User user)
    {
        AccessQueryCount++;
        return _accessProjection(itemIds, user);
    }
}
