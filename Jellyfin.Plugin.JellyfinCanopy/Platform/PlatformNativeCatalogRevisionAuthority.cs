using System;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Process-keyed authority for catalog semantic revisions. A revision proves only
    /// equality with another authorized projection; it cannot be enumerated to recover
    /// per-user feature state.
    /// </summary>
    public sealed class PlatformNativeCatalogRevisionAuthority : IDisposable
    {
        private static readonly byte[] Domain =
            Encoding.ASCII.GetBytes("jellyfin-canopy/platform-native-catalog/v1");

        private readonly byte[] _key;
        private bool _disposed;

        /// <summary>Creates one process-local revision authority.</summary>
        public PlatformNativeCatalogRevisionAuthority()
            : this(RandomNumberGenerator.GetBytes(32))
        {
        }

        internal PlatformNativeCatalogRevisionAuthority(ReadOnlySpan<byte> key)
        {
            if (key.Length != 32)
            {
                throw new ArgumentException("The catalog revision key must contain 32 bytes.", nameof(key));
            }

            _key = key.ToArray();
        }

        internal string Create(ReadOnlySpan<byte> authorizedSemanticProjection)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            if (authorizedSemanticProjection.Length is < 1 or > 64 * 1024)
            {
                throw new ArgumentException("The catalog projection is outside its fixed byte bound.", nameof(authorizedSemanticProjection));
            }

            var input = new byte[Domain.Length + authorizedSemanticProjection.Length];
            Domain.CopyTo(input, 0);
            authorizedSemanticProjection.CopyTo(input.AsSpan(Domain.Length));
            try
            {
                return "catalog-v1-" + Convert.ToHexString(HMACSHA256.HashData(_key, input)).ToLowerInvariant();
            }
            finally
            {
                CryptographicOperations.ZeroMemory(input);
            }
        }

        /// <inheritdoc />
        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            CryptographicOperations.ZeroMemory(_key);
            _disposed = true;
        }
    }
}
