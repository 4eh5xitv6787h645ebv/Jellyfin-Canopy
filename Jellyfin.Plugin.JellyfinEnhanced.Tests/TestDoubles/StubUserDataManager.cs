using System;
using System.Collections.Generic;
using System.Threading;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;

/// <summary>
/// Minimal <see cref="IUserDataManager"/> fake. <see cref="GetUserData(User, BaseItem)"/> is backed
/// by an optional hook (default: returns null, i.e. "no user data / not played"); every other member
/// throws, matching the repo's NotImplemented-stub convention.
/// </summary>
public sealed class StubUserDataManager : IUserDataManager
{
    /// <summary>When set, backs <see cref="GetUserData(User, BaseItem)"/>.</summary>
    public Func<User, BaseItem, UserItemData?>? GetUserDataHook { get; set; }

    public event EventHandler<UserDataSaveEventArgs>? UserDataSaved { add { } remove { } }

    public UserItemData? GetUserData(User user, BaseItem item)
        => GetUserDataHook?.Invoke(user, item);

    // ---- Everything below is an unused NotImplemented stub (per the repo convention). ----

    public void SaveUserData(User user, BaseItem item, UserItemData userData, UserDataSaveReason reason, CancellationToken cancellationToken) => throw new NotImplementedException();

    public void SaveUserData(User user, BaseItem item, UpdateUserItemDataDto userDataDto, UserDataSaveReason reason) => throw new NotImplementedException();

    public UserItemDataDto? GetUserDataDto(BaseItem item, User user) => throw new NotImplementedException();

    public Dictionary<Guid, UserItemData> GetUserDataBatch(IReadOnlyList<BaseItem> items, User user) => throw new NotImplementedException();

    public UserItemDataDto? GetUserDataDto(BaseItem item, BaseItemDto? itemDto, User user, DtoOptions options) => throw new NotImplementedException();

    public bool UpdatePlayState(BaseItem item, UserItemData data, long? reportedPositionTicks) => throw new NotImplementedException();
}
