using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting
{
    /// <summary>
    /// The only way the platform kernel is allowed to reach Jellyfin.
    ///
    /// <para>
    /// The charter's decision to keep the kernel inside Canopy rather than shipping it
    /// as a separate plugin is only safe <b>because</b> of this seam. Without it the
    /// kernel and Canopy's own features fuse, and extracting the kernel later becomes a
    /// breaking change for every consumer — risk R-07. The seam keeps extraction
    /// <i>possible</i> without making it <i>required</i>.
    /// </para>
    /// <para>
    /// That is not merely tidiness. It is also half of the T-16 argument: every extra
    /// plugin this programme ships is another reserved manifest <c>name</c> that Jellyfin
    /// will deduplicate against, and another way for a namesake plugin to delete an
    /// installation. Being able to postpone that decision has real value.
    /// </para>
    /// <para>
    /// No member of this interface, or of any type it exposes, may mention a
    /// <c>MediaBrowser</c> type — otherwise the dependency simply moves one level down
    /// and the seam stops meaning anything. <c>PlatformHostSeamTests</c> enforces this
    /// against the source, in the style of <c>AtomicFileWriteGuardTests</c>.
    /// </para>
    /// </summary>
    public interface IPlatformHost
    {
        /// <summary>Users and their administrative status.</summary>
        IHostUsers Users { get; }

        /// <summary>Library item lookup.</summary>
        IHostLibrary Library { get; }

        /// <summary>Active client sessions.</summary>
        IHostSessions Sessions { get; }

        /// <summary>Installed plugin metadata.</summary>
        IHostPlugins Plugins { get; }
    }

    /// <summary>Users, as the kernel needs them.</summary>
    public interface IHostUsers
    {
        /// <summary>
        /// The user with <paramref name="id"/>, or <c>null</c> if the host has none.
        ///
        /// Returning <c>null</c> rather than throwing: a user disappearing between
        /// authentication and use is ordinary (deletion, a stale token), not exceptional.
        /// </summary>
        HostUser? Find(Guid id);

        /// <summary>Every user the host knows about.</summary>
        IReadOnlyList<HostUser> All();
    }

    /// <summary>Library items, as the kernel needs them.</summary>
    public interface IHostLibrary
    {
        /// <summary>
        /// The item with <paramref name="id"/>, or <c>null</c> if there is none.
        /// This unscoped inventory read is never an authorization decision. Platform
        /// catalog resolution and action admission must use <see cref="FindAccessible"/>.
        /// </summary>
        HostItem? Find(Guid id);

        /// <summary>
        /// Resolves one item through the current host access policy for the current user.
        /// Missing users and items, deleted content, and every access denial collapse to
        /// <see cref="HostItemAccessResult.NotAccessible"/> so the kernel cannot infer why
        /// the item was unavailable.
        /// </summary>
        /// <param name="userId">Authenticated acting-user id. Never caller-selected metadata.</param>
        /// <param name="itemId">Jellyfin item id. All other item facts come from the host.</param>
        HostItemAccessResult FindAccessible(Guid userId, Guid itemId);

        /// <summary>
        /// The direct children of <paramref name="id"/>, empty when it has none or does
        /// not exist.
        ///
        /// Empty rather than <c>null</c> for a missing parent, because the kernel's
        /// callers iterate this and a missing parent is not distinguishable from an
        /// empty one in any way they act on.
        /// </summary>
        IReadOnlyList<HostItem> ChildrenOf(Guid id);
    }

    /// <summary>Sessions, as the kernel needs them.</summary>
    public interface IHostSessions
    {
        /// <summary>Every currently active session.</summary>
        IReadOnlyList<HostSession> Active();

        /// <summary>The active sessions belonging to <paramref name="userId"/>.</summary>
        IReadOnlyList<HostSession> ForUser(Guid userId);
    }

    /// <summary>Installed plugins, as the kernel needs them.</summary>
    public interface IHostPlugins
    {
        /// <summary>Every installed plugin the host reports, in the host's own order.</summary>
        IReadOnlyList<HostPlugin> Installed();

        /// <summary>The installed plugin with <paramref name="id"/>, or <c>null</c>.</summary>
        HostPlugin? Find(Guid id);

        /// <summary>
        /// Takes one immutable host-issued observation of every installed plugin.
        /// Internal because installation topology is acquisition input, not public API.
        /// </summary>
        internal IReadOnlyList<PlatformInstalledPluginSnapshot> InstalledSnapshots();

        /// <summary>
        /// Takes one host-issued observation for <paramref name="id"/>, or <c>null</c>.
        /// This is a fresh host read and not authority that an earlier snapshot remains current.
        /// </summary>
        internal PlatformInstalledPluginSnapshot? FindSnapshot(Guid id);
    }
}
