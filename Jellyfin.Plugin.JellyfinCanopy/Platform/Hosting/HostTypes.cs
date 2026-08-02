using System;
using System.Collections.Immutable;

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

    /// <summary>Closed item kinds understood by the Platform kernel.</summary>
    public enum HostItemKind
    {
        /// <summary>A host item outside the bounded native item-detail kinds.</summary>
        Other,

        /// <summary>A movie.</summary>
        Movie,

        /// <summary>A television series.</summary>
        Series,

        /// <summary>A television episode.</summary>
        Episode,
    }

    /// <summary>
    /// A bounded server-derived provider reference. These are correlation hints only;
    /// callers must never treat one as proof that an item is accessible.
    /// </summary>
    /// <param name="Provider">Canonical bounded provider name.</param>
    /// <param name="Value">Opaque bounded provider value.</param>
    public readonly record struct HostProviderReference(string Provider, string Value);

    /// <summary>
    /// The minimum item projection released after a current user-scoped access query.
    /// It deliberately carries no name, path, library id, arbitrary parent id, or host
    /// object. <see cref="SeriesId"/> is server-derived ancestry for correlation only;
    /// a consumer must separately resolve that ancestor through the same user-scoped
    /// seam before acting on it.
    /// </summary>
    /// <param name="Id">The exact accessible item id requested by the kernel.</param>
    /// <param name="Kind">Server-derived closed item kind.</param>
    /// <param name="SeriesId">Server-derived series ancestry, when the host item has one.</param>
    /// <param name="ProviderReferences">Immutable bounded provider-correlation hints.</param>
    public readonly record struct HostAccessibleItem
    {
        /// <summary>
        /// Creates a projection inside the trusted host adapter. Consumers can inspect
        /// projections returned by <see cref="IHostLibrary.FindAccessible"/>, but cannot
        /// mint one from client-shaped metadata.
        /// </summary>
        internal HostAccessibleItem(
            Guid id,
            HostItemKind kind,
            Guid? seriesId,
            ImmutableArray<HostProviderReference> providerReferences)
        {
            Id = id;
            Kind = kind;
            SeriesId = seriesId;
            ProviderReferences = providerReferences;
        }

        /// <summary>Gets the exact accessible item id requested by the kernel.</summary>
        public Guid Id { get; }

        /// <summary>Gets the server-derived closed item kind.</summary>
        public HostItemKind Kind { get; }

        /// <summary>Gets server-derived series ancestry, when present.</summary>
        public Guid? SeriesId { get; }

        /// <summary>Gets immutable bounded provider-correlation hints.</summary>
        public ImmutableArray<HostProviderReference> ProviderReferences { get; }
    }

    /// <summary>
    /// Result of a user-scoped item access decision. Every negative host condition has
    /// the same representation; no reason or unscoped candidate escapes the adapter.
    /// </summary>
    public readonly record struct HostItemAccessResult
    {
        private readonly HostAccessibleItem? _item;

        private HostItemAccessResult(HostAccessibleItem item) => _item = item;

        /// <summary>The single representation for missing users/items and access denials.</summary>
        public static HostItemAccessResult NotAccessible => default;

        /// <summary>Gets the accessible projection, or <c>null</c> for every denial.</summary>
        public HostAccessibleItem? Item => _item;

        /// <summary>Whether the host released an accessible projection.</summary>
        public bool IsAccessible => Item.HasValue;

        /// <summary>Creates positive authorization state inside the trusted host adapter.</summary>
        internal static HostItemAccessResult Accessible(HostAccessibleItem item) => new(item);
    }

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
