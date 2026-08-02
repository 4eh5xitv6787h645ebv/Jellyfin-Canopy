using System;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>
    /// Process-local keyed authority for opaque presentation revisions. The key
    /// never crosses the owner boundary, so enumerable user/provider inputs cannot
    /// be tested against a published revision with an offline dictionary.
    /// </summary>
    internal interface ISeerrItemPresentationRevisionAuthority
    {
        string Create(string domain, params string[] semanticParts);
    }

    /// <summary>Singleton HMAC authority with length-prefixed domain separation.</summary>
    internal sealed class SeerrItemPresentationRevisionAuthority
        : ISeerrItemPresentationRevisionAuthority, IDisposable
    {
        private const int AuthorityKeyBytes = 32;
        private readonly object _gate = new();
        private readonly byte[] _authorityKey;
        private bool _disposed;

        public SeerrItemPresentationRevisionAuthority()
            : this(RandomNumberGenerator.GetBytes(AuthorityKeyBytes))
        {
        }

        internal SeerrItemPresentationRevisionAuthority(byte[] authorityKey)
        {
            ArgumentNullException.ThrowIfNull(authorityKey);
            if (authorityKey.Length != AuthorityKeyBytes)
            {
                throw new ArgumentException(
                    $"Revision authority keys must be exactly {AuthorityKeyBytes} bytes.",
                    nameof(authorityKey));
            }

            _authorityKey = (byte[])authorityKey.Clone();
        }

        public string Create(string domain, params string[] semanticParts)
        {
            ArgumentException.ThrowIfNullOrEmpty(domain);
            ArgumentNullException.ThrowIfNull(semanticParts);
            lock (_gate)
            {
                ObjectDisposedException.ThrowIf(_disposed, this);
                using var hmac = IncrementalHash.CreateHMAC(
                    HashAlgorithmName.SHA256,
                    _authorityKey);
                Append(hmac, "jellyfin-canopy/seerr-item-presentation/v1");
                Append(hmac, domain);
                foreach (var part in semanticParts)
                {
                    Append(hmac, part ?? string.Empty);
                }

                return "r1-" + Convert.ToHexString(hmac.GetHashAndReset());
            }
        }

        public void Dispose()
        {
            lock (_gate)
            {
                if (_disposed)
                {
                    return;
                }

                CryptographicOperations.ZeroMemory(_authorityKey);
                _disposed = true;
            }
        }

        private static void Append(IncrementalHash hmac, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
            hmac.AppendData(length);
            hmac.AppendData(bytes);
        }
    }
}
