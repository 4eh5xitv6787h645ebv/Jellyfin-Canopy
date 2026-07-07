using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Audio;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Resolvers;
using MediaBrowser.Controller.Sorting;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Querying;
using Episode = MediaBrowser.Controller.Entities.TV.Episode;
using Genre = MediaBrowser.Controller.Entities.Genre;
using LinkedChildType = MediaBrowser.Controller.Entities.LinkedChildType;
using Person = MediaBrowser.Controller.Entities.Person;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;

/// <summary>
/// Minimal <see cref="ILibraryManager"/> fake for the monitor-idempotency tests. Only the three
/// library-scan events are real: each keeps a backing delegate so the test can read the true
/// subscriber count (invocation-list length), which mirrors .NET event semantics exactly — a
/// <c>-=</c> for a handler that was never added is a no-op (so unsubscribe-then-resubscribe stays
/// at one). Every other member throws, matching the repo's NotImplemented-stub convention.
/// </summary>
public sealed class CountingLibraryManager : ILibraryManager
{
    private EventHandler<ItemChangeEventArgs>? _itemAdded;
    private EventHandler<ItemChangeEventArgs>? _itemUpdated;
    private EventHandler<ItemChangeEventArgs>? _itemRemoved;

    public event EventHandler<ItemChangeEventArgs>? ItemAdded
    {
        add => _itemAdded += value;
        remove => _itemAdded -= value;
    }

    public event EventHandler<ItemChangeEventArgs>? ItemUpdated
    {
        add => _itemUpdated += value;
        remove => _itemUpdated -= value;
    }

    public event EventHandler<ItemChangeEventArgs>? ItemRemoved
    {
        add => _itemRemoved += value;
        remove => _itemRemoved -= value;
    }

    /// <summary>Live subscriber count for ItemAdded.</summary>
    public int ItemAddedCount => _itemAdded?.GetInvocationList().Length ?? 0;

    /// <summary>Live subscriber count for ItemUpdated.</summary>
    public int ItemUpdatedCount => _itemUpdated?.GetInvocationList().Length ?? 0;

    /// <summary>Live subscriber count for ItemRemoved.</summary>
    public int ItemRemovedCount => _itemRemoved?.GetInvocationList().Length ?? 0;

    // ---- Optional query hooks (default null = throw, per convention). Set by tests that need
    //      BuildFullCache's full scan (GetItemList) and per-id resolve (GetItemById<T>). ----

    /// <summary>When set, backs the single-arg <see cref="GetItemList(InternalItemsQuery)"/>.</summary>
    public Func<InternalItemsQuery, IReadOnlyList<BaseItem>>? GetItemListHook { get; set; }

    /// <summary>When set, backs the generic <see cref="GetItemById{T}(Guid)"/>.</summary>
    public Func<Guid, BaseItem?>? GetItemByIdHook { get; set; }

    /// <summary>When set, backs the user-scoped <see cref="GetItemById{T}(Guid, User?)"/>.</summary>
    public Func<Guid, User?, BaseItem?>? GetItemByIdUserHook { get; set; }

    // ---- Everything below is an unused NotImplemented stub (per the repo convention). ----

    public AggregateFolder RootFolder => throw new NotImplementedException();

    public bool IsScanRunning => throw new NotImplementedException();

    public BaseItem? ResolvePath(FileSystemMetadata fileInfo, Folder? parent = null, IDirectoryService? directoryService = null, CollectionType? collectionType = null) => throw new NotImplementedException();

    public Video? ResolveAlternateVersion(string path, Type expectedVideoType, Folder? parent, CollectionType? collectionType) => throw new NotImplementedException();

    public IEnumerable<BaseItem> ResolvePaths(IEnumerable<FileSystemMetadata> files, IDirectoryService directoryService, Folder parent, LibraryOptions libraryOptions, CollectionType? collectionType = null) => throw new NotImplementedException();

    public Person? GetPerson(string name) => throw new NotImplementedException();

    public BaseItem? FindByPath(string path, bool? isFolder) => throw new NotImplementedException();

    public MusicArtist GetArtist(string name) => throw new NotImplementedException();

    public MusicArtist GetArtist(string name, DtoOptions options) => throw new NotImplementedException();

    public Studio GetStudio(string name) => throw new NotImplementedException();

    public Genre GetGenre(string name) => throw new NotImplementedException();

    public MusicGenre GetMusicGenre(string name) => throw new NotImplementedException();

    public Year GetYear(int value) => throw new NotImplementedException();

    public Task ValidatePeopleAsync(IProgress<double> progress, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task ValidateMediaLibrary(IProgress<double> progress, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task ValidateTopLibraryFolders(CancellationToken cancellationToken, bool removeRoot = false) => throw new NotImplementedException();

    public void ClearIgnoreRuleCache() => throw new NotImplementedException();

    public Task UpdateImagesAsync(BaseItem item, bool forceUpdate = false) => throw new NotImplementedException();

    public List<VirtualFolderInfo> GetVirtualFolders() => throw new NotImplementedException();

    public List<VirtualFolderInfo> GetVirtualFolders(bool includeRefreshState) => throw new NotImplementedException();

    public BaseItem? GetItemById(Guid id) => throw new NotImplementedException();

    public T? GetItemById<T>(Guid id)
        where T : BaseItem => GetItemByIdHook is null ? throw new NotImplementedException() : GetItemByIdHook(id) as T;

    public T? GetItemById<T>(Guid id, Guid userId)
        where T : BaseItem => throw new NotImplementedException();

    public T? GetItemById<T>(Guid id, User? user)
        where T : BaseItem => GetItemByIdUserHook is null ? throw new NotImplementedException() : GetItemByIdUserHook(id, user) as T;

    public Task<IEnumerable<Video>> GetIntros(BaseItem item, User user) => throw new NotImplementedException();

    public IEnumerable<Guid> GetLocalAlternateVersionIds(Video video) => throw new NotImplementedException();

    public IEnumerable<Video> GetLinkedAlternateVersions(Video video) => throw new NotImplementedException();

    public void UpsertLinkedChild(Guid parentId, Guid childId, LinkedChildType childType) => throw new NotImplementedException();

    public void AddParts(IEnumerable<IResolverIgnoreRule> rules, IEnumerable<IItemResolver> resolvers, IEnumerable<IIntroProvider> introProviders, IEnumerable<IBaseItemComparer> itemComparers, IEnumerable<ILibraryPostScanTask> postScanTasks) => throw new NotImplementedException();

    public IEnumerable<BaseItem> Sort(IEnumerable<BaseItem> items, User? user, IEnumerable<ItemSortBy> sortBy, SortOrder sortOrder) => throw new NotImplementedException();

    public IEnumerable<BaseItem> Sort(IEnumerable<BaseItem> items, User? user, IEnumerable<(ItemSortBy OrderBy, SortOrder SortOrder)> orderBy) => throw new NotImplementedException();

    public Folder GetUserRootFolder() => throw new NotImplementedException();

    public void CreateItem(BaseItem item, BaseItem? parent) => throw new NotImplementedException();

    public void CreateItems(IReadOnlyList<BaseItem> items, BaseItem? parent, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task UpdateItemsAsync(IReadOnlyList<BaseItem> items, BaseItem parent, ItemUpdateType updateReason, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task UpdateItemAsync(BaseItem item, BaseItem parent, ItemUpdateType updateReason, CancellationToken cancellationToken) => throw new NotImplementedException();

    public Task ReattachUserDataAsync(BaseItem item, CancellationToken cancellationToken) => throw new NotImplementedException();

    public BaseItem RetrieveItem(Guid id) => throw new NotImplementedException();

    public CollectionType? GetContentType(BaseItem item) => throw new NotImplementedException();

    public CollectionType? GetInheritedContentType(BaseItem item) => throw new NotImplementedException();

    public CollectionType? GetConfiguredContentType(BaseItem item) => throw new NotImplementedException();

    public CollectionType? GetConfiguredContentType(string path) => throw new NotImplementedException();

    public List<FileSystemMetadata> NormalizeRootPathList(IEnumerable<FileSystemMetadata> paths) => throw new NotImplementedException();

    public void RegisterItem(BaseItem item) => throw new NotImplementedException();

    public void DeleteItem(BaseItem item, DeleteOptions options) => throw new NotImplementedException();

    public void DeleteItemsUnsafeFast(IReadOnlyCollection<BaseItem> items, bool deleteSourceFiles = false) => throw new NotImplementedException();

    public void DeleteItem(BaseItem item, DeleteOptions options, bool notifyParentItem) => throw new NotImplementedException();

    public void DeleteItem(BaseItem item, DeleteOptions options, BaseItem parent, bool notifyParentItem) => throw new NotImplementedException();

    public UserView GetNamedView(User user, string name, Guid parentId, CollectionType? viewType, string sortName) => throw new NotImplementedException();

    public UserView GetNamedView(User user, string name, CollectionType? viewType, string sortName) => throw new NotImplementedException();

    public UserView GetNamedView(string name, CollectionType viewType, string sortName) => throw new NotImplementedException();

    public UserView GetNamedView(string name, Guid parentId, CollectionType? viewType, string sortName, string uniqueId) => throw new NotImplementedException();

    public UserView GetShadowView(BaseItem parent, CollectionType? viewType, string sortName) => throw new NotImplementedException();

    public int? GetSeasonNumberFromPath(string path, Guid? parentId) => throw new NotImplementedException();

    public bool FillMissingEpisodeNumbersFromPath(Episode episode, bool forceRefresh) => throw new NotImplementedException();

    public ItemLookupInfo ParseName(string name) => throw new NotImplementedException();

    public Guid GetNewItemId(string key, Type type) => throw new NotImplementedException();

    public IEnumerable<BaseItem> FindExtras(BaseItem owner, IReadOnlyList<FileSystemMetadata> fileSystemChildren, IDirectoryService directoryService) => throw new NotImplementedException();

    public List<Folder> GetCollectionFolders(BaseItem item) => throw new NotImplementedException();

    public List<Folder> GetCollectionFolders(BaseItem item, IEnumerable<Folder> allUserRootChildren) => throw new NotImplementedException();

    public LibraryOptions GetLibraryOptions(BaseItem item) => throw new NotImplementedException();

    public IReadOnlyList<PersonInfo> GetPeople(BaseItem item) => throw new NotImplementedException();

    public IReadOnlyList<PersonInfo> GetPeople(InternalPeopleQuery query) => throw new NotImplementedException();

    public QueryResult<BaseItem> GetPeopleItems(InternalPeopleQuery query) => throw new NotImplementedException();

    public void UpdatePeople(BaseItem item, List<PersonInfo> people) => throw new NotImplementedException();

    public Task UpdatePeopleAsync(BaseItem item, IReadOnlyList<PersonInfo> people, CancellationToken cancellationToken) => throw new NotImplementedException();

    public IReadOnlyList<Guid> GetItemIds(InternalItemsQuery query) => throw new NotImplementedException();

    public IReadOnlyList<string> GetPeopleNames(InternalPeopleQuery query) => throw new NotImplementedException();

    public IReadOnlyDictionary<Guid, IReadOnlyList<string>> GetPeopleNamesByItems(IReadOnlyList<Guid> itemIds, IReadOnlyList<string> personTypes) => throw new NotImplementedException();

    public QueryResult<BaseItem> QueryItems(InternalItemsQuery query) => throw new NotImplementedException();

    public string GetPathAfterNetworkSubstitution(string path, BaseItem? ownerItem = null) => throw new NotImplementedException();

    public Task<ItemImageInfo> ConvertImageToLocal(BaseItem item, ItemImageInfo image, int imageIndex, bool removeOnFailure = true) => throw new NotImplementedException();

    public IReadOnlyList<BaseItem> GetItemList(InternalItemsQuery query) => GetItemListHook is null ? throw new NotImplementedException() : GetItemListHook(query);

    public IReadOnlyList<BaseItem> GetItemList(InternalItemsQuery query, bool allowExternalContent) => throw new NotImplementedException();

    public IReadOnlyList<BaseItem> GetItemList(InternalItemsQuery query, List<BaseItem> parents) => throw new NotImplementedException();

    public IReadOnlyList<BaseItem> GetLatestItemList(InternalItemsQuery query, IReadOnlyList<BaseItem> parents, CollectionType collectionType) => throw new NotImplementedException();

    public IReadOnlyList<string> GetNextUpSeriesKeys(InternalItemsQuery query, IReadOnlyCollection<BaseItem> parents, DateTime dateCutoff) => throw new NotImplementedException();

    public IReadOnlyDictionary<string, MediaBrowser.Controller.Persistence.NextUpEpisodeBatchResult> GetNextUpEpisodesBatch(InternalItemsQuery query, IReadOnlyList<string> seriesKeys, bool includeSpecials, bool includeWatchedForRewatching) => throw new NotImplementedException();

    public QueryResult<BaseItem> GetItemsResult(InternalItemsQuery query) => throw new NotImplementedException();

    public bool IgnoreFile(FileSystemMetadata file, BaseItem parent) => throw new NotImplementedException();

    public Guid GetStudioId(string name) => throw new NotImplementedException();

    public Guid GetGenreId(string name) => throw new NotImplementedException();

    public Guid GetMusicGenreId(string name) => throw new NotImplementedException();

    public Task AddVirtualFolder(string name, CollectionTypeOptions? collectionType, LibraryOptions options, bool refreshLibrary) => throw new NotImplementedException();

    public Task RemoveVirtualFolder(string name, bool refreshLibrary) => throw new NotImplementedException();

    public void AddMediaPath(string virtualFolderName, MediaPathInfo mediaPath) => throw new NotImplementedException();

    public void UpdateMediaPath(string virtualFolderName, MediaPathInfo mediaPath) => throw new NotImplementedException();

    public void RemoveMediaPath(string virtualFolderName, string mediaPath) => throw new NotImplementedException();

    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetGenres(InternalItemsQuery query) => throw new NotImplementedException();

    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetMusicGenres(InternalItemsQuery query) => throw new NotImplementedException();

    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetStudios(InternalItemsQuery query) => throw new NotImplementedException();

    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetArtists(InternalItemsQuery query) => throw new NotImplementedException();

    public IReadOnlyDictionary<string, MusicArtist[]> GetArtists(IReadOnlyList<string> names) => throw new NotImplementedException();

    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetAlbumArtists(InternalItemsQuery query) => throw new NotImplementedException();

    public QueryResult<(BaseItem Item, ItemCounts ItemCounts)> GetAllArtists(InternalItemsQuery query) => throw new NotImplementedException();

    public int GetCount(InternalItemsQuery query) => throw new NotImplementedException();

    public ItemCounts GetItemCounts(InternalItemsQuery query) => throw new NotImplementedException();

    public ItemCounts GetItemCountsForNameItem(BaseItemKind kind, Guid id, BaseItemKind[] relatedItemKinds, User? user) => throw new NotImplementedException();

    public Dictionary<Guid, int> GetChildCountBatch(IReadOnlyList<Guid> parentIds, Guid? userId) => throw new NotImplementedException();

    public Dictionary<Guid, (int Played, int Total)> GetPlayedAndTotalCountBatch(IReadOnlyList<Guid> folderIds, User user) => throw new NotImplementedException();

    public void ConfigureUserAccess(InternalItemsQuery query, User user) => throw new NotImplementedException();

    public Task RunMetadataSavers(BaseItem item, ItemUpdateType updateReason) => throw new NotImplementedException();

    public BaseItem GetParentItem(Guid? parentId, Guid? userId) => throw new NotImplementedException();

    public void QueueLibraryScan() => throw new NotImplementedException();

    public void CreateShortcut(string virtualFolderPath, MediaPathInfo pathInfo) => throw new NotImplementedException();

    public Task RerouteLinkedChildReferencesAsync(Guid fromChildId, Guid toChildId) => throw new NotImplementedException();

    public QueryFiltersLegacy GetQueryFiltersLegacy(InternalItemsQuery query) => throw new NotImplementedException();

    public IReadOnlyList<string> GetMediaStreamLanguages(MediaStreamType mediaStreamType) => throw new NotImplementedException();
}
