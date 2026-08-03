using System.Buffers.Binary;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformNativePreparedStateTests
{
    [Fact]
    public void Spoiler_RoundTripsExactCanonicalState()
    {
        var state = PlatformNativePreparedState.Spoiler(enabled: true, revision: 17);

        var encoded = PlatformNativePreparedStateCodec.Encode(state);

        Assert.True(PlatformNativePreparedStateCodec.TryDecode(encoded, out var decoded));
        Assert.Equal(state, decoded);
    }

    [Theory]
    [InlineData(HiddenContentItemScope.Global)]
    [InlineData(HiddenContentItemScope.ContinueWatching)]
    [InlineData(HiddenContentItemScope.NextUp)]
    [InlineData(HiddenContentItemScope.HomeSections)]
    public void Hidden_RoundTripsEveryClosedScope(HiddenContentItemScope scope)
    {
        var state = PlatformNativePreparedState.Hidden(hidden: true, scope, revision: 23);

        var encoded = PlatformNativePreparedStateCodec.Encode(state);

        Assert.True(PlatformNativePreparedStateCodec.TryDecode(encoded, out var decoded));
        Assert.Equal(state, decoded);
    }

    [Theory]
    [InlineData(SeerrMediaRequestVariant.Standard)]
    [InlineData(SeerrMediaRequestVariant.FourK)]
    public void Seerr_RoundTripsExactOpaqueRevisions(SeerrMediaRequestVariant variant)
    {
        var state = PlatformNativePreparedState.Seerr(variant, Presentation(
            new string('a', 128),
            "user-v1",
            "item-v1",
            "provider-v1"));

        var encoded = PlatformNativePreparedStateCodec.Encode(state);

        Assert.True(PlatformNativePreparedStateCodec.TryDecode(encoded, out var decoded));
        Assert.Equal(state, decoded);
    }

    [Fact]
    public void EveryProperPrefixAndEveryTrailingSuffixFailsClosed()
    {
        var encoded = PlatformNativePreparedStateCodec.Encode(PlatformNativePreparedState.Seerr(
            SeerrMediaRequestVariant.Standard,
            Presentation("config", "user", "item", "provider")));

        for (var length = 0; length < encoded.Length; length++)
        {
            Assert.False(
                PlatformNativePreparedStateCodec.TryDecode(encoded.AsSpan(0, length), out _),
                $"A truncated payload of {length} bytes was accepted.");
        }

        Assert.False(PlatformNativePreparedStateCodec.TryDecode(encoded.Concat(new byte[] { 0 }).ToArray(), out _));
    }

    [Theory]
    [InlineData(0, 2)]
    [InlineData(1, 0)]
    [InlineData(1, 255)]
    [InlineData(10, 2)]
    [InlineData(11, 255)]
    [InlineData(12, 255)]
    public void UnknownVersionEnumsAndNonBooleanBytesFailClosed(int offset, byte replacement)
    {
        var encoded = PlatformNativePreparedStateCodec.Encode(
            PlatformNativePreparedState.Hidden(true, HiddenContentItemScope.Global, 1));
        encoded[offset] = replacement;

        Assert.False(PlatformNativePreparedStateCodec.TryDecode(encoded, out _));
    }

    [Fact]
    public void NegativeResourceRevisionFailsClosed()
    {
        var encoded = PlatformNativePreparedStateCodec.Encode(
            PlatformNativePreparedState.Spoiler(enabled: false, revision: 1));
        BinaryPrimitives.WriteInt64BigEndian(encoded.AsSpan(2, 8), -1);

        Assert.False(PlatformNativePreparedStateCodec.TryDecode(encoded, out _));
    }

    [Fact]
    public void OversizedPayloadAndDeclaredStringFailClosed()
    {
        var oversizedPayload = new byte[PlatformPrepareSnapshot.MaximumPrivateStateBytes + 1];
        var encoded = PlatformNativePreparedStateCodec.Encode(PlatformNativePreparedState.Seerr(
            SeerrMediaRequestVariant.Standard,
            Presentation("config", "user", "item", "provider")));
        BinaryPrimitives.WriteUInt16BigEndian(encoded.AsSpan(13, 2), 129);

        Assert.False(PlatformNativePreparedStateCodec.TryDecode(oversizedPayload, out _));
        Assert.False(PlatformNativePreparedStateCodec.TryDecode(encoded, out _));
    }

    [Fact]
    public void InvalidUtf8WhitespaceAndControlCharactersFailClosed()
    {
        var invalidUtf8 = PlatformNativePreparedStateCodec.Encode(PlatformNativePreparedState.Seerr(
            SeerrMediaRequestVariant.Standard,
            Presentation("config", "user", "item", "provider")));
        invalidUtf8[15] = 0xFF;

        foreach (var invalid in new[] { "contains space", "contains\ttab", "contains\nnewline", "control\u0001" })
        {
            var encoded = PlatformNativePreparedStateCodec.Encode(PlatformNativePreparedState.Seerr(
                SeerrMediaRequestVariant.Standard,
                Presentation(invalid, "user", "item", "provider")));
            Assert.False(PlatformNativePreparedStateCodec.TryDecode(encoded, out _));
        }

        Assert.False(PlatformNativePreparedStateCodec.TryDecode(invalidUtf8, out _));
    }

    [Fact]
    public void EncodeRejectsRevisionOverTheFixedUtf8ByteBound()
    {
        var state = PlatformNativePreparedState.Seerr(
            SeerrMediaRequestVariant.Standard,
            Presentation(new string('é', 65), "user", "item", "provider"));

        Assert.Throws<ArgumentException>(() => PlatformNativePreparedStateCodec.Encode(state));
    }

    [Fact]
    public void NonCanonicalCrossFamilyStateCannotBeDecoded()
    {
        var cases = new[]
        {
            new PlatformNativePreparedState(
                PlatformNativePreparedFamily.SpoilerGuard,
                1,
                false,
                HiddenContentItemScope.NextUp,
                SeerrMediaRequestVariant.Standard,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty),
            new PlatformNativePreparedState(
                PlatformNativePreparedFamily.HiddenContent,
                1,
                false,
                HiddenContentItemScope.Global,
                SeerrMediaRequestVariant.FourK,
                string.Empty,
                string.Empty,
                string.Empty,
                string.Empty),
            new PlatformNativePreparedState(
                PlatformNativePreparedFamily.Seerr,
                1,
                false,
                HiddenContentItemScope.Global,
                SeerrMediaRequestVariant.Standard,
                "config",
                "user",
                "item",
                "provider"),
            new PlatformNativePreparedState(
                PlatformNativePreparedFamily.Seerr,
                0,
                true,
                HiddenContentItemScope.Global,
                SeerrMediaRequestVariant.Standard,
                "config",
                "user",
                "item",
                "provider"),
            new PlatformNativePreparedState(
                PlatformNativePreparedFamily.Seerr,
                0,
                false,
                HiddenContentItemScope.Global,
                SeerrMediaRequestVariant.Standard,
                string.Empty,
                "user",
                "item",
                "provider"),
        };

        foreach (var state in cases)
        {
            Assert.False(PlatformNativePreparedStateCodec.TryDecode(
                PlatformNativePreparedStateCodec.Encode(state),
                out _));
        }
    }

    [Fact]
    public void EncodeRejectsNullState()
    {
        Assert.Throws<ArgumentNullException>(() => PlatformNativePreparedStateCodec.Encode(null!));
    }

    private static SeerrItemRequestPresentation Presentation(
        string configurationRevision,
        string userRevision,
        string itemRevision,
        string providerRevision)
        => SeerrItemRequestPresentation.Available(
            standardRequestAvailable: true,
            fourKRequestAvailable: true,
            SeerrItemRequestStatus.Unavailable,
            SeerrItemRequestStatus.Unavailable,
            configurationRevision,
            userRevision,
            itemRevision,
            providerRevision);
}

public sealed class PlatformNativeCatalogRevisionAuthorityTests
{
    private static readonly byte[] ProjectionA = Encoding.UTF8.GetBytes("authorized-projection-a");

    [Fact]
    public void SameKeyAndProjectionProduceStableCanonicalRevision()
    {
        using var authority = new PlatformNativeCatalogRevisionAuthority(Enumerable.Repeat((byte)0x31, 32).ToArray());

        var first = authority.Create(ProjectionA);
        var second = authority.Create(ProjectionA);

        Assert.Equal(first, second);
        Assert.StartsWith("catalog-v1-", first, StringComparison.Ordinal);
        Assert.Equal(75, first.Length);
        Assert.All(first[11..], character => Assert.True(character is >= '0' and <= '9' or >= 'a' and <= 'f'));
    }

    [Fact]
    public void ProjectionAndAuthorityKeysAreDomainSeparated()
    {
        using var firstAuthority = new PlatformNativeCatalogRevisionAuthority(Enumerable.Repeat((byte)0x41, 32).ToArray());
        using var secondAuthority = new PlatformNativeCatalogRevisionAuthority(Enumerable.Repeat((byte)0x42, 32).ToArray());

        var original = firstAuthority.Create(ProjectionA);
        var differentProjection = firstAuthority.Create(Encoding.UTF8.GetBytes("authorized-projection-b"));
        var differentKey = secondAuthority.Create(ProjectionA);

        Assert.NotEqual(original, differentProjection);
        Assert.NotEqual(original, differentKey);
        Assert.NotEqual(differentProjection, differentKey);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(31)]
    [InlineData(33)]
    public void ConstructorRequiresExact256BitKey(int length)
    {
        Assert.Throws<ArgumentException>(() => new PlatformNativeCatalogRevisionAuthority(new byte[length]));
    }

    [Fact]
    public void ProjectionBoundsRejectEmptyAndOver64KiB()
    {
        using var authority = new PlatformNativeCatalogRevisionAuthority(new byte[32]);

        Assert.Throws<ArgumentException>(() => authority.Create(ReadOnlySpan<byte>.Empty));
        Assert.Throws<ArgumentException>(() => authority.Create(new byte[(64 * 1024) + 1]));
        Assert.NotEmpty(authority.Create(new byte[64 * 1024]));
    }

    [Fact]
    public void DisposeIsIdempotentAndPermanentlyRevokesCreation()
    {
        var authority = new PlatformNativeCatalogRevisionAuthority(new byte[32]);
        Assert.NotEmpty(authority.Create(ProjectionA));

        authority.Dispose();
        authority.Dispose();

        Assert.Throws<ObjectDisposedException>(() => authority.Create(ProjectionA));
    }
}
