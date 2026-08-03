using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    internal enum PlatformNativePreparedFamily : byte
    {
        SpoilerGuard = 1,
        HiddenContent = 2,
        Seerr = 3,
    }

    /// <summary>Strict server-private state carried from resolve through invoke.</summary>
    internal sealed record PlatformNativePreparedState(
        PlatformNativePreparedFamily Family,
        long ResourceRevision,
        bool CurrentBoolean,
        HiddenContentItemScope HiddenScope,
        SeerrMediaRequestVariant SeerrVariant,
        string ConfigurationRevision,
        string UserRevision,
        string ItemRevision,
        string ProviderRevision)
    {
        internal static PlatformNativePreparedState Spoiler(bool enabled, long revision)
            => new(
                PlatformNativePreparedFamily.SpoilerGuard,
                revision,
                enabled,
                HiddenContentItemScope.Global,
                SeerrMediaRequestVariant.Standard,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty);

        internal static PlatformNativePreparedState Hidden(
            bool hidden,
            HiddenContentItemScope scope,
            long revision)
            => new(
                PlatformNativePreparedFamily.HiddenContent,
                revision,
                hidden,
                scope,
                SeerrMediaRequestVariant.Standard,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty);

        internal static PlatformNativePreparedState Seerr(
            SeerrMediaRequestVariant variant,
            SeerrItemRequestPresentation presentation)
            => new(
                PlatformNativePreparedFamily.Seerr,
                0,
                false,
                HiddenContentItemScope.Global,
                variant,
                presentation.ConfigurationRevision,
                presentation.UserRevision,
                presentation.ItemRevision,
                presentation.ProviderRevision);
    }

    internal static class PlatformNativePreparedStateCodec
    {
        private const byte Version = 1;
        private const int MaximumRevisionBytes = 128;

        internal static byte[] Encode(PlatformNativePreparedState state)
        {
            ArgumentNullException.ThrowIfNull(state);
            using var stream = new MemoryStream();
            stream.WriteByte(Version);
            stream.WriteByte((byte)state.Family);
            WriteInt64(stream, state.ResourceRevision);
            stream.WriteByte(state.CurrentBoolean ? (byte)1 : (byte)0);
            stream.WriteByte((byte)state.HiddenScope);
            stream.WriteByte((byte)state.SeerrVariant);
            WriteString(stream, state.ConfigurationRevision);
            WriteString(stream, state.UserRevision);
            WriteString(stream, state.ItemRevision);
            WriteString(stream, state.ProviderRevision);
            return stream.ToArray();
        }

        internal static bool TryDecode(ReadOnlySpan<byte> bytes, out PlatformNativePreparedState state)
        {
            state = null!;
            if (bytes.Length < 14 || bytes.Length > PlatformPreparedActionContextOwner.MaximumPrivateStateBytes)
            {
                return false;
            }

            var offset = 0;
            if (bytes[offset++] != Version
                || !TryEnum(bytes[offset++], out PlatformNativePreparedFamily family)
                || !TryReadInt64(bytes, ref offset, out var resourceRevision)
                || resourceRevision < 0
                || offset + 3 > bytes.Length)
            {
                return false;
            }

            var booleanByte = bytes[offset++];
            if (booleanByte > 1
                || !TryEnum(bytes[offset++], out HiddenContentItemScope hiddenScope)
                || !TryEnum(bytes[offset++], out SeerrMediaRequestVariant seerrVariant)
                || !TryReadString(bytes, ref offset, out var config)
                || !TryReadString(bytes, ref offset, out var user)
                || !TryReadString(bytes, ref offset, out var item)
                || !TryReadString(bytes, ref offset, out var provider)
                || offset != bytes.Length)
            {
                return false;
            }

            state = new PlatformNativePreparedState(
                family,
                resourceRevision,
                booleanByte == 1,
                hiddenScope,
                seerrVariant,
                config,
                user,
                item,
                provider);
            return IsCanonical(state);
        }

        private static bool IsCanonical(PlatformNativePreparedState state) => state.Family switch
        {
            PlatformNativePreparedFamily.SpoilerGuard =>
                state.HiddenScope == HiddenContentItemScope.Global
                && state.SeerrVariant == SeerrMediaRequestVariant.Standard
                && EmptyRevisions(state),
            PlatformNativePreparedFamily.HiddenContent =>
                state.SeerrVariant == SeerrMediaRequestVariant.Standard
                && EmptyRevisions(state),
            PlatformNativePreparedFamily.Seerr =>
                state.ResourceRevision == 0
                && !state.CurrentBoolean
                && state.HiddenScope == HiddenContentItemScope.Global
                && NonEmptyRevisions(state),
            _ => false,
        };

        private static bool EmptyRevisions(PlatformNativePreparedState state)
            => state.ConfigurationRevision.Length == 0
                && state.UserRevision.Length == 0
                && state.ItemRevision.Length == 0
                && state.ProviderRevision.Length == 0;

        private static bool NonEmptyRevisions(PlatformNativePreparedState state)
            => IsRevision(state.ConfigurationRevision)
                && IsRevision(state.UserRevision)
                && IsRevision(state.ItemRevision)
                && IsRevision(state.ProviderRevision);

        private static bool IsRevision(string value)
            => value.Length > 0
                && Encoding.UTF8.GetByteCount(value) <= MaximumRevisionBytes
                && value.IndexOf(' ') < 0
                && value.IndexOf('\t') < 0
                && value.IndexOf('\r') < 0
                && value.IndexOf('\n') < 0;

        private static void WriteString(Stream stream, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            if (bytes.Length > MaximumRevisionBytes)
            {
                throw new ArgumentException("A prepared revision exceeds its fixed byte bound.", nameof(value));
            }

            Span<byte> length = stackalloc byte[2];
            BinaryPrimitives.WriteUInt16BigEndian(length, checked((ushort)bytes.Length));
            stream.Write(length);
            stream.Write(bytes);
        }

        private static bool TryReadString(ReadOnlySpan<byte> source, ref int offset, out string value)
        {
            value = string.Empty;
            if (offset + 2 > source.Length)
            {
                return false;
            }

            var length = BinaryPrimitives.ReadUInt16BigEndian(source.Slice(offset, 2));
            offset += 2;
            if (length > MaximumRevisionBytes || offset + length > source.Length)
            {
                return false;
            }

            try
            {
                value = new UTF8Encoding(false, true).GetString(source.Slice(offset, length));
            }
            catch (DecoderFallbackException)
            {
                return false;
            }

            offset += length;
            return value.All(character => !char.IsControl(character) && !char.IsWhiteSpace(character));
        }

        private static void WriteInt64(Stream stream, long value)
        {
            Span<byte> buffer = stackalloc byte[8];
            BinaryPrimitives.WriteInt64BigEndian(buffer, value);
            stream.Write(buffer);
        }

        private static bool TryReadInt64(ReadOnlySpan<byte> source, ref int offset, out long value)
        {
            value = 0;
            if (offset + 8 > source.Length)
            {
                return false;
            }

            value = BinaryPrimitives.ReadInt64BigEndian(source.Slice(offset, 8));
            offset += 8;
            return true;
        }

        private static bool TryEnum<T>(byte value, out T result)
            where T : struct, Enum
        {
            result = (T)Enum.ToObject(typeof(T), value);
            return Enum.IsDefined(result);
        }
    }
}
