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

    /// <summary>
    /// Jellyfin's closed installed-plugin states, kept independent of the host enum so
    /// the rest of the Platform kernel does not acquire a host assembly dependency.
    ///
    /// Undefined numeric values are deliberately retained when the adapter sees a newer
    /// host state. Acquisition can then fail closed without silently reclassifying it as
    /// one of the states this version understands.
    /// </summary>
    internal enum PlatformInstalledPluginHostStatus
    {
        /// <summary>A restart is required before the host-side change takes effect.</summary>
        Restart = 0,

        /// <summary>The plugin is currently active.</summary>
        Active = 1,

        /// <summary>The plugin is disabled.</summary>
        Disabled = 2,

        /// <summary>The plugin does not meet the host ABI requirements.</summary>
        NotSupported = 3,

        /// <summary>The plugin failed while the host instantiated it.</summary>
        Malfunctioned = 4,

        /// <summary>Another installed version supersedes this plugin.</summary>
        Superseded = 5,

        /// <summary>The host has marked the plugin for deletion.</summary>
        Deleted = 6,
    }

    /// <summary>
    /// One immutable observation minted from a real Jellyfin <c>LocalPlugin</c>.
    ///
    /// The public facts are inert host identity only. Installation topology remains
    /// internal so it cannot become a caller-selected path API or leak through the
    /// long-standing public <see cref="HostPlugin"/> projection. This observation is
    /// not approval, a grant, registry state, or proof that the plugin remains installed.
    /// </summary>
    internal sealed class PlatformInstalledPluginSnapshot
    {
        private PlatformInstalledPluginSnapshot(
            Guid pluginId,
            string name,
            Version version,
            PlatformInstalledPluginHostStatus status,
            string reportedRoot,
            ImmutableArray<string> reportedDllFiles)
        {
            PluginId = pluginId;
            Name = name;
            Version = version;
            Status = status;
            ReportedRoot = reportedRoot;
            DllFiles = reportedDllFiles.IsDefault
                ? ImmutableArray<string>.Empty
                : reportedDllFiles;
        }

        /// <summary>Gets the GUID reported by Jellyfin for this installed plugin.</summary>
        public Guid PluginId { get; }

        /// <summary>Gets the host-reported display name. It is attribution, never identity.</summary>
        public string Name { get; }

        /// <summary>Gets the typed version reported by Jellyfin.</summary>
        public Version Version { get; }

        /// <summary>Gets the exact closed host status observed for this plugin.</summary>
        public PlatformInstalledPluginHostStatus Status { get; }

        /// <summary>Gets the untrusted installation root reported by Jellyfin.</summary>
        internal string ReportedRoot { get; }

        /// <summary>Gets an immutable copy of Jellyfin's inert DLL-file observations.</summary>
        internal ImmutableArray<string> DllFiles { get; }

        /// <summary>
        /// Mints one observation inside the trusted Jellyfin adapter. Architecture tests
        /// keep this factory out of every other production owner.
        /// </summary>
        internal static PlatformInstalledPluginSnapshot EstablishHostSnapshot(
            Guid pluginId,
            string name,
            Version version,
            PlatformInstalledPluginHostStatus status,
            string reportedRoot,
            ImmutableArray<string> reportedDllFiles) => new(
                pluginId,
                name,
                version,
                status,
                reportedRoot,
                reportedDllFiles);
    }
}
