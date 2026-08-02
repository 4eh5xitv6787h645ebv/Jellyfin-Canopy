namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Constants shared by every Platform v1 surface.
    ///
    /// Platform v1 is the versioned, capability-scoped boundary described in
    /// <c>research/extension-platform/</c>. It is deliberately separate from the
    /// existing <c>/JellyfinCanopy/*</c> routes, which remain compatibility surfaces
    /// and are never promoted into the platform implicitly.
    /// </summary>
    public static class PlatformConstants
    {
        /// <summary>
        /// Maximum time spent in Platform v1 model binding and action execution.
        /// Request-body buffering is separately bounded and deliberately happens first.
        /// </summary>
        public static readonly System.TimeSpan RequestDeadline = System.TimeSpan.FromSeconds(30);

        /// <summary>
        /// The Platform v1 route family.
        ///
        /// The <c>v1</c> segment is a MAJOR version. Incompatible majors coexist as
        /// separate route families rather than mutating in place, so a consumer can
        /// upgrade on its own schedule (ADR-0001, ADR-0010).
        /// </summary>
        public const string RoutePrefix = "JellyfinCanopy/Platform/v1";

        /// <summary>Lowest protocol version this host speaks.</summary>
        public const int ProtocolMinimum = 1;

        /// <summary>Highest protocol version this host speaks.</summary>
        public const int ProtocolMaximum = 1;
    }
}
