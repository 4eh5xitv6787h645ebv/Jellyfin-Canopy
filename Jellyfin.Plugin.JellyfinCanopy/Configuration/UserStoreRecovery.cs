using System;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Raised when a per-user JSON store has entered the durable recovery state.
    /// Retrying the original mutation cannot clear this state; an elevated reset
    /// or an operator repair is required.
    /// </summary>
    internal sealed class UserStoreUnhealthyException : Exception
    {
        public UserStoreUnhealthyException(string fileName, bool newlyQuarantined, Exception? innerException = null)
            : base($"'{fileName}' is quarantined and requires explicit recovery.", innerException)
        {
            FileName = fileName;
            NewlyQuarantined = newlyQuarantined;
        }

        public string FileName { get; }

        /// <summary>
        /// True only for the call that created the durable unhealthy marker.
        /// Consumers that maintain a user-visible corruption event can use this
        /// to avoid recording the same generation on every retry.
        /// </summary>
        public bool NewlyQuarantined { get; }
    }

    internal sealed class UserStoreUnhealthyMarker
    {
        public const int CurrentVersion = 1;

        public int Version { get; set; } = CurrentVersion;

        public string FileName { get; set; } = string.Empty;

        public string QuarantineFileName { get; set; } = string.Empty;

        public string ContentSha256 { get; set; } = string.Empty;

        public long SourceBytes { get; set; }

        public string DetectedAtUtc { get; set; } = string.Empty;
    }

    internal sealed class UserStoreRecoveryStatus
    {
        public string UserId { get; set; } = string.Empty;

        public string FileName { get; set; } = string.Empty;

        public string DetectedAtUtc { get; set; } = string.Empty;

        public long SourceBytes { get; set; }

        public string ContentSha256 { get; set; } = string.Empty;

        public string QuarantineFileName { get; set; } = string.Empty;

        public bool MarkerReadable { get; set; }

        public bool QuarantineComplete { get; set; }
    }
}
