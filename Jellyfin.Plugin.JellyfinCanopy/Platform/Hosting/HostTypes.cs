using System;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting
{
    /// <summary>
    /// A user, as the platform kernel sees one.
    ///
    /// Deliberately not Jellyfin's <c>User</c>. If a host type crossed this seam the
    /// seam would not exist: every kernel type touching a user would gain a
    /// <c>MediaBrowser</c> dependency, which is the exact coupling risk R-07 is about.
    /// </summary>
    /// <param name="Id">The user's stable identifier.</param>
    /// <param name="Name">Display name. Presentation only; never an authorization input.</param>
    /// <param name="IsAdministrator">Whether the host considers this user an administrator.</param>
    public readonly record struct HostUser(Guid Id, string Name, bool IsAdministrator);

    /// <summary>
    /// A library item, reduced to what the kernel can act on without understanding
    /// Jellyfin's entity hierarchy.
    /// </summary>
    /// <param name="Id">The item's stable identifier.</param>
    /// <param name="Name">Display name.</param>
    /// <param name="Kind">The host's type name for the item, for example <c>Series</c> or <c>Episode</c>.</param>
    /// <param name="ParentId">The containing item, when there is one.</param>
    public readonly record struct HostItem(Guid Id, string Name, string Kind, Guid? ParentId);

    /// <summary>
    /// An active playback or client session.
    /// </summary>
    /// <param name="Id">The session identifier.</param>
    /// <param name="UserId">The user the session belongs to, when it is associated with one.</param>
    /// <param name="DeviceId">Caller-supplied device identifier. Attribution only, never authority (ADR-0011).</param>
    /// <param name="Client">The client application name reported by the session.</param>
    public readonly record struct HostSession(string Id, Guid? UserId, string? DeviceId, string? Client);

    /// <summary>
    /// An installed plugin, as reported by the host.
    ///
    /// EP-00 established two facts encoded by this shape: the status of an installed
    /// plugin lives on its manifest rather than on the plugin object, and a runtime
    /// "disable" produces <c>Restart</c> rather than <c>Disabled</c> because nothing is
    /// ever actually unloaded (spike-evidence S5, S6).
    /// </summary>
    /// <param name="Id">The plugin's GUID.</param>
    /// <param name="Name">The manifest name, which is also what Jellyfin orders plugin loading by.</param>
    /// <param name="Version">The installed version.</param>
    /// <param name="Status">The host's status string for the plugin, for example <c>Active</c> or <c>Restart</c>.</param>
    public readonly record struct HostPlugin(Guid Id, string Name, string Version, string Status);
}
