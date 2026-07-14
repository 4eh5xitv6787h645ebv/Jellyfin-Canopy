using System;
using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr
{
    /// <summary>
    /// Immutable digest of the complete plugin configuration used to authorize
    /// and prepare one Seerr mutation. Admin saves replace the live configuration
    /// object, and in-place changes are also detected by hashing every serialized
    /// setting. A write may proceed only if the current digest still matches
    /// immediately after its last awaited identity lookup.
    /// </summary>
    internal readonly struct SeerrMutationConfigStamp
    {
        private readonly byte[]? _digest;
        private readonly long _revision;

        private SeerrMutationConfigStamp(byte[] digest, long revision)
        {
            _digest = digest;
            _revision = revision;
        }

        public static SeerrMutationConfigStamp Capture(
            PluginConfiguration configuration,
            long revision)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            var serialized = JsonSerializer.SerializeToUtf8Bytes(configuration);
            return new SeerrMutationConfigStamp(SHA256.HashData(serialized), revision);
        }

        public bool Matches(PluginConfiguration? configuration, long revision)
        {
            if (configuration == null || _digest == null || revision != _revision) return false;
            var serialized = JsonSerializer.SerializeToUtf8Bytes(configuration);
            var currentDigest = SHA256.HashData(serialized);
            return CryptographicOperations.FixedTimeEquals(_digest, currentDigest);
        }
    }
}
