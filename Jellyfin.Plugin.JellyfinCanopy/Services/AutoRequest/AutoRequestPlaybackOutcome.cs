namespace Jellyfin.Plugin.JellyfinCanopy.Services.AutoRequest
{
    /// <summary>
    /// Classifies the result of one playback-triggered auto-request check for
    /// the outer playback-event deduplicator.
    /// </summary>
    public enum AutoRequestPlaybackOutcome
    {
        /// <summary>A request was created, or dispatch may have committed it.</summary>
        Committed,

        /// <summary>The authoritative state says no request is needed.</summary>
        DefinitiveNoop,

        /// <summary>No mutation could have committed and a later event may retry.</summary>
        RetryableFailure,

        /// <summary>The check was cancelled before a definitive outcome.</summary>
        Cancelled,
    }
}
