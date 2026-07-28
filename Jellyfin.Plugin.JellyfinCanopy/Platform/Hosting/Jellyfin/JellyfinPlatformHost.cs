using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin
{
    /// <summary>
    /// The one place the platform kernel's view of the host is joined to the real
    /// Jellyfin managers.
    ///
    /// <para>
    /// This file, and only this file, is allowed to mention the host's types on the
    /// platform's behalf. <c>PlatformHostSeamTests</c> enforces that against the source
    /// and fails if a second file starts doing it, in the same style as
    /// <c>AtomicFileWriteGuardTests</c>. A rule that lives only in review erodes.
    /// </para>
    /// <para>
    /// Everything here is translation. There is no policy, no authorization decision and
    /// no caching: an adapter that starts deciding things becomes a second place where
    /// behaviour lives, and the extraction this seam exists to protect stops being a
    /// mechanical move.
    /// </para>
    /// <para>
    /// The host is reached through narrow delegates rather than by holding the managers.
    /// Jellyfin's manager interfaces are far too large to implement in a test, so holding
    /// them directly would leave every mapping below permanently unverified — and the
    /// mappings are where the real defects live (an id that should have become
    /// <c>null</c>, a status read from the wrong place). The public constructor binds the
    /// delegates to the managers and is the only part that cannot be exercised offline.
    /// </para>
    /// </summary>
    public sealed class JellyfinPlatformHost : IPlatformHost
    {
        /// <summary>Initializes a new instance of the <see cref="JellyfinPlatformHost"/> class.</summary>
        /// <param name="userManager">Host user manager.</param>
        /// <param name="libraryManager">Host library manager.</param>
        /// <param name="sessionManager">Host session manager.</param>
        /// <param name="pluginManager">Host plugin manager.</param>
        public JellyfinPlatformHost(
            IUserManager userManager,
            ILibraryManager libraryManager,
            ISessionManager sessionManager,
            IPluginManager pluginManager)
            : this(
                id => userManager.GetUserById(id),
                () => userManager.GetUsers(),
                id => libraryManager.GetItemById(id),
                () => sessionManager.Sessions,
                () => pluginManager.Plugins)
        {
        }

        /// <summary>
        /// Test seam (Tests has InternalsVisibleTo): the host reduced to the five reads
        /// the kernel actually performs, so every mapping below can be verified without
        /// standing up Jellyfin.
        /// </summary>
        /// <param name="findUser">Resolves a user by id, or <c>null</c>.</param>
        /// <param name="allUsers">Enumerates every user.</param>
        /// <param name="findItem">Resolves a library item by id, or <c>null</c>.</param>
        /// <param name="activeSessions">Enumerates active sessions.</param>
        /// <param name="installedPlugins">Enumerates installed plugins.</param>
        internal JellyfinPlatformHost(
            Func<Guid, User?> findUser,
            Func<IEnumerable<User>> allUsers,
            Func<Guid, BaseItem?> findItem,
            Func<IEnumerable<SessionInfo>> activeSessions,
            Func<IEnumerable<LocalPlugin>> installedPlugins)
        {
            Users = new HostUsers(findUser, allUsers);
            Library = new HostLibrary(findItem);
            Sessions = new HostSessions(activeSessions);
            Plugins = new HostPlugins(installedPlugins);
        }

        /// <inheritdoc />
        public IHostUsers Users { get; }

        /// <inheritdoc />
        public IHostLibrary Library { get; }

        /// <inheritdoc />
        public IHostSessions Sessions { get; }

        /// <inheritdoc />
        public IHostPlugins Plugins { get; }

        private sealed class HostUsers : IHostUsers
        {
            private readonly Func<Guid, User?> _find;
            private readonly Func<IEnumerable<User>> _all;

            public HostUsers(Func<Guid, User?> find, Func<IEnumerable<User>> all)
            {
                _find = find;
                _all = all;
            }

            public HostUser? Find(Guid id)
            {
                var user = _find(id);
                return user is null ? null : Map(user);
            }

            public IReadOnlyList<HostUser> All() => _all().Select(Map).ToList();

            private static HostUser Map(User user) => new(
                user.Id,
                user.Username,
                user.HasPermission(PermissionKind.IsAdministrator));
        }

        private sealed class HostLibrary : IHostLibrary
        {
            private readonly Func<Guid, BaseItem?> _find;

            public HostLibrary(Func<Guid, BaseItem?> find) => _find = find;

            public HostItem? Find(Guid id)
            {
                var item = _find(id);
                return item is null ? null : Map(item);
            }

            public IReadOnlyList<HostItem> ChildrenOf(Guid id)
            {
                // A missing parent yields an empty list rather than throwing: the kernel's
                // callers iterate this, and they cannot act differently on "no such parent"
                // than on "parent with no children".
                if (_find(id) is not Folder folder)
                {
                    return Array.Empty<HostItem>();
                }

                return folder.Children.Select(Map).ToList();
            }

            private static HostItem Map(BaseItem item) => new(
                item.Id,
                item.Name ?? string.Empty,
                item.GetType().Name,
                item.ParentId == Guid.Empty ? null : item.ParentId);
        }

        private sealed class HostSessions : IHostSessions
        {
            private readonly Func<IEnumerable<SessionInfo>> _active;

            public HostSessions(Func<IEnumerable<SessionInfo>> active) => _active = active;

            public IReadOnlyList<HostSession> Active() => _active().Select(Map).ToList();

            public IReadOnlyList<HostSession> ForUser(Guid userId) => _active()
                .Where(session => session.UserId == userId)
                .Select(Map)
                .ToList();

            private static HostSession Map(SessionInfo session) => new(
                session.Id,
                session.UserId == Guid.Empty ? null : session.UserId,
                session.DeviceId,
                session.Client);
        }

        private sealed class HostPlugins : IHostPlugins
        {
            private readonly Func<IEnumerable<LocalPlugin>> _installed;

            public HostPlugins(Func<IEnumerable<LocalPlugin>> installed) => _installed = installed;

            public IReadOnlyList<HostPlugin> Installed() => _installed().Select(Map).ToList();

            public HostPlugin? Find(Guid id)
            {
                var plugin = _installed().FirstOrDefault(candidate => candidate.Id == id);
                return plugin is null ? null : Map(plugin);
            }

            // EP-00 (spike-evidence S5/S6): the status lives on the MANIFEST, not on the
            // LocalPlugin - LocalPlugin.Status does not exist - and a runtime disable
            // produces Restart rather than Disabled, because nothing is ever unloaded.
            private static HostPlugin Map(LocalPlugin plugin) => new(
                plugin.Id,
                plugin.Name,
                plugin.Version.ToString(),
                plugin.Manifest.Status.ToString());
        }
    }
}
