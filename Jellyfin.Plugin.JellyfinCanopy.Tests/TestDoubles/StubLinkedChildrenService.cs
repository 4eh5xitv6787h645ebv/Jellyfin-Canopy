using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Persistence;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;

public sealed class StubLinkedChildrenService : ILinkedChildrenService
{
    public Func<Guid, int?, IReadOnlyList<Guid>>? GetChildrenHook { get; set; }

    public Func<Guid, BaseItemKind?, IReadOnlyList<Guid>>? GetParentsHook { get; set; }

    public int GetChildrenCallCount { get; private set; }

    public int GetParentsCallCount { get; private set; }

    public IReadOnlyList<Guid> GetLinkedChildrenIds(Guid parentId, int? childType = null)
    {
        GetChildrenCallCount++;
        return GetChildrenHook?.Invoke(parentId, childType) ?? Array.Empty<Guid>();
    }

    public IReadOnlyList<Guid> GetManualLinkedParentIds(Guid childId, BaseItemKind? parentType = null)
    {
        GetParentsCallCount++;
        return GetParentsHook?.Invoke(childId, parentType) ?? Array.Empty<Guid>();
    }

    public IReadOnlyDictionary<string, MusicArtist[]> FindArtists(IReadOnlyList<string> artistNames)
        => throw new NotImplementedException();

    public IReadOnlyList<Guid> RerouteLinkedChildren(Guid fromChildId, Guid toChildId)
        => throw new NotImplementedException();

    public void UpsertLinkedChild(Guid parentId, Guid childId, LinkedChildType childType)
        => throw new NotImplementedException();
}
