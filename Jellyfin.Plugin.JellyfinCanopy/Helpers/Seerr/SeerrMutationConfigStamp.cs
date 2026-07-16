using System;
using System.Globalization;
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

        /// <summary>
        /// Serializes the mutable provider object once, then derives both the
        /// owned configuration clone and its stamp from those exact bytes.
        /// Consumers can project URLs, credentials, and options from the clone
        /// without combining values observed at different instants.
        /// </summary>
        internal static (PluginConfiguration Configuration, SeerrMutationConfigStamp Stamp) CaptureOwnedSnapshot(
            PluginConfiguration configuration,
            long revision)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            var serialized = JsonSerializer.SerializeToUtf8Bytes(configuration);
            var ownedConfiguration = JsonSerializer.Deserialize<PluginConfiguration>(serialized)
                ?? throw new JsonException("The plugin configuration snapshot could not be deserialized.");
            return (
                ownedConfiguration,
                new SeerrMutationConfigStamp(SHA256.HashData(serialized), revision));
        }

        internal static PluginConfiguration CloneOwnedConfiguration(
            PluginConfiguration configuration)
        {
            ArgumentNullException.ThrowIfNull(configuration);
            var serialized = JsonSerializer.SerializeToUtf8Bytes(configuration);
            return JsonSerializer.Deserialize<PluginConfiguration>(serialized)
                ?? throw new JsonException("The owned plugin configuration could not be cloned.");
        }

        public bool Matches(PluginConfiguration? configuration, long revision)
        {
            if (configuration == null || _digest == null || revision != _revision) return false;
            var serialized = JsonSerializer.SerializeToUtf8Bytes(configuration);
            var currentDigest = SHA256.HashData(serialized);
            return CryptographicOperations.FixedTimeEquals(_digest, currentDigest);
        }

        /// <summary>
        /// Opaque identity for the exact configuration generation captured by
        /// this stamp. The digest binds every serialized option without
        /// retaining credentials in plaintext; the revision keeps an identical
        /// replacement save distinct from the object it superseded.
        /// </summary>
        internal string GenerationIdentity => _digest == null
            ? string.Empty
            : $"{_revision.ToString(CultureInfo.InvariantCulture)}:{Convert.ToHexString(_digest)}";
    }
}
