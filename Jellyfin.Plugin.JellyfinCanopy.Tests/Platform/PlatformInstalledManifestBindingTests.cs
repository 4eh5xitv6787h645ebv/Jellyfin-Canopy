using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Text;
using System.Threading;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformInstalledManifestBindingTests
{
    private static readonly Guid PluginId = new("11111111-2222-3333-4444-555555555555");

    [Fact]
    public void HonestActiveObservationBindsEveryHostAndManifestFactWithoutAuthority()
    {
        var before = Snapshot();
        var manifestBytes = ManifestBytes(capabilities: new[]
        {
            "jellyfin.canopy.storage.read",
            "jellyfin.canopy.items.lookup",
        });
        Assert.True(PlatformExtensionManifestParser.TryParse(
            manifestBytes,
            out var independentlyParsed,
            out var parseReason));
        Assert.Equal(PlatformExtensionManifestRejectionReason.None, parseReason);

        var observation = PlatformInstalledManifestBinder.Bind(
            before,
            Snapshot(),
            PlatformInstalledManifestReadResult.Acquired(manifestBytes, "Example.Provider"));

        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, observation.Outcome);
        Assert.Equal(PlatformInstalledPluginHostStatus.Active, observation.HostStatus);
        Assert.Equal(PlatformInstalledManifestCompatibility.Compatible, observation.Compatibility);
        Assert.Null(observation.ManifestRejectionReason);
        var bound = Assert.IsType<HostBoundInstalledManifest>(observation.BoundManifest);
        Assert.Equal(PluginId, bound.PluginId);
        Assert.Equal(new Version(1, 2, 3, 4), bound.HostVersion);
        Assert.Equal("Example.Provider", bound.AssemblyIdentity);
        Assert.Equal(PlatformInstalledPluginHostStatus.Active, bound.HostStatus);
        Assert.Equal(independentlyParsed!.Fingerprint.Value, bound.Manifest.Fingerprint.Value);
        Assert.Equal(
            new[] { "jellyfin.canopy.items.lookup", "jellyfin.canopy.storage.read" },
            bound.Manifest.RequestedCapabilities.Capabilities.Select(value => value.Id.Value));

        var forbiddenAuthorityShape = new[]
        {
            "Approved", "Granted", "Effective", "Enabled", "Registered", "Callable",
            "Credential", "Secret", "Actor", "Registry", "Lifecycle", "RawBytes",
            "RootPath", "AssemblyPath", "Exception",
        };
        Assert.DoesNotContain(
            bound.GetType().GetProperties(),
            property => forbiddenAuthorityShape.Contains(property.Name, StringComparer.OrdinalIgnoreCase));
    }

    [Theory]
    [InlineData((int)PlatformInstalledPluginHostStatus.Restart)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Disabled)]
    [InlineData((int)PlatformInstalledPluginHostStatus.NotSupported)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Malfunctioned)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Superseded)]
    [InlineData((int)PlatformInstalledPluginHostStatus.Deleted)]
    public void EveryKnownNonActiveHostStatusRemainsDistinctAndNeverBinds(int statusValue)
    {
        var status = (PlatformInstalledPluginHostStatus)statusValue;
        var observation = Bind(status: status);

        Assert.Equal(PlatformInstalledManifestOutcome.HostStatusNotActive, observation.Outcome);
        Assert.Equal(status, observation.HostStatus);
        Assert.Null(observation.BoundManifest);
    }

    [Fact]
    public void UnknownFutureNumericStatusesRemainDistinctAndNeverBind()
    {
        var first = (PlatformInstalledPluginHostStatus)901;
        var second = (PlatformInstalledPluginHostStatus)902;

        var firstObservation = Bind(status: first);
        var secondObservation = Bind(status: second);

        Assert.Equal(first, firstObservation.HostStatus);
        Assert.Equal(second, secondObservation.HostStatus);
        Assert.NotEqual(firstObservation.HostStatus, secondObservation.HostStatus);
        Assert.Equal(PlatformInstalledManifestOutcome.HostStatusNotActive, firstObservation.Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.HostStatusNotActive, secondObservation.Outcome);
        Assert.Null(firstObservation.BoundManifest);
        Assert.Null(secondObservation.BoundManifest);
    }

    [Fact]
    public void GuidVersionMismatchesAndAssemblyAbsenceAreDistinctClosedOutcomes()
    {
        AssertOutcome(
            PlatformInstalledManifestOutcome.PluginIdMismatch,
            ManifestBytes(pluginId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
        AssertOutcome(
            PlatformInstalledManifestOutcome.PluginVersionMismatch,
            ManifestBytes(version: "1.2.3.5"));

        var unavailable = PlatformInstalledManifestBinder.Bind(
            Snapshot(),
            Snapshot(),
            PlatformInstalledManifestReadResult.Acquired(ManifestBytes(), null));
        Assert.Equal(PlatformInstalledManifestOutcome.AssemblyUnavailable, unavailable.Outcome);
        Assert.Null(unavailable.BoundManifest);

        var componentCountMismatch = PlatformInstalledManifestBinder.Bind(
            Snapshot(version: new Version(1, 2)),
            Snapshot(version: new Version(1, 2)),
            PlatformInstalledManifestReadResult.Acquired(
                ManifestBytes(version: "1.2.0"),
                "Example.Provider"));
        Assert.Equal(
            PlatformInstalledManifestOutcome.PluginVersionMismatch,
            componentCountMismatch.Outcome);
        Assert.Null(componentCountMismatch.BoundManifest);
    }

    [Fact]
    public void EveryHostFactChangingDuringReadFailsClosed()
    {
        var changes = new[]
        {
            Snapshot(pluginId: Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")),
            Snapshot(version: new Version(1, 2, 3, 5)),
            Snapshot(status: PlatformInstalledPluginHostStatus.Restart),
            Snapshot(root: "/plugins/example-moved"),
            Snapshot(dllFiles: new[] { "/plugins/example/Other.dll" }),
        };

        Assert.All(changes, after =>
        {
            var observation = PlatformInstalledManifestBinder.Bind(
                Snapshot(),
                after,
                PlatformInstalledManifestReadResult.Acquired(ManifestBytes(), "Example.Provider"));
            Assert.Equal(PlatformInstalledManifestOutcome.HostSnapshotChanged, observation.Outcome);
            Assert.Null(observation.BoundManifest);
        });
    }

    [Theory]
    [InlineData(1, 1, 12, 12, (int)PlatformInstalledManifestCompatibility.Compatible)]
    [InlineData(2, 2, 12, 12, (int)PlatformInstalledManifestCompatibility.PlatformIncompatible)]
    [InlineData(1, 1, 11, 11, (int)PlatformInstalledManifestCompatibility.HostIncompatible)]
    [InlineData(2, 2, 13, 13, (int)PlatformInstalledManifestCompatibility.PlatformIncompatible)]
    public void CompatibilityIsSeparateExactClosedMetadata(
        int platformMin,
        int platformMax,
        int hostMin,
        int hostMax,
        int expectedValue)
    {
        var observation = Bind(bytes: ManifestBytes(
            platformMin: platformMin,
            platformMax: platformMax,
            hostMin: hostMin,
            hostMax: hostMax));

        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, observation.Outcome);
        Assert.Equal((PlatformInstalledManifestCompatibility)expectedValue, observation.Compatibility!.Value);
        Assert.NotNull(observation.BoundManifest);
    }

    [Fact]
    public void ParserReceivesUnchangedBytesAndItsClosedReasonIsPreserved()
    {
        var cases = new[]
        {
            (new byte[] { 0xEF, 0xBB, 0xBF }.Concat(ManifestBytes()).ToArray(),
                PlatformExtensionManifestRejectionReason.InvalidUtf8),
            (new byte[] { (byte)'{', (byte)'"', 0xFF, (byte)'"', (byte)':', (byte)'1', (byte)'}' },
                PlatformExtensionManifestRejectionReason.InvalidUtf8),
            (Encoding.UTF8.GetBytes("{"), PlatformExtensionManifestRejectionReason.InvalidJson),
            (Encoding.UTF8.GetBytes(new string('[', PlatformExtensionManifestBounds.MaximumJsonDepth + 1)
                + "0" + new string(']', PlatformExtensionManifestBounds.MaximumJsonDepth + 1)),
                PlatformExtensionManifestRejectionReason.InvalidJson),
        };

        foreach (var (bytes, reason) in cases)
        {
            var observation = Bind(bytes: bytes);
            Assert.Equal(PlatformInstalledManifestOutcome.ManifestRejected, observation.Outcome);
            Assert.Equal(reason, observation.ManifestRejectionReason);
            Assert.Null(observation.BoundManifest);
        }
    }

    [Fact]
    public void AcquiredReadResultDefensivelyOwnsBytesBeforeBinding()
    {
        var source = ManifestBytes();
        var readResult = PlatformInstalledManifestReadResult.Acquired(source, "Example.Provider");
        source.AsSpan().Fill((byte)'x');

        var observation = PlatformInstalledManifestBinder.Bind(Snapshot(), Snapshot(), readResult);

        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, observation.Outcome);
        Assert.Equal("org.example.provider", observation.BoundManifest!.Manifest.Id);
    }

    [Theory]
    [InlineData((int)PlatformInstalledManifestOutcome.ManifestAbsent)]
    [InlineData((int)PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot)]
    [InlineData((int)PlatformInstalledManifestOutcome.UnsafeTarget)]
    [InlineData((int)PlatformInstalledManifestOutcome.OpenTimedOut)]
    [InlineData((int)PlatformInstalledManifestOutcome.NotRegularFile)]
    [InlineData((int)PlatformInstalledManifestOutcome.DescriptorUnverifiable)]
    [InlineData((int)PlatformInstalledManifestOutcome.DocumentTooLarge)]
    [InlineData((int)PlatformInstalledManifestOutcome.ReadChanged)]
    [InlineData((int)PlatformInstalledManifestOutcome.ReadFailed)]
    public void ReaderFailuresPassThroughWithoutParsingOrPartialBinding(int outcomeValue)
    {
        var outcome = (PlatformInstalledManifestOutcome)outcomeValue;
        var observation = PlatformInstalledManifestBinder.Bind(
            Snapshot(),
            Snapshot(),
            PlatformInstalledManifestReadResult.Rejected(outcome));

        Assert.Equal(outcome, observation.Outcome);
        Assert.Null(observation.ManifestRejectionReason);
        Assert.Null(observation.BoundManifest);
    }

    private static void AssertOutcome(PlatformInstalledManifestOutcome expected, byte[] bytes)
    {
        var observation = Bind(bytes: bytes);
        Assert.Equal(expected, observation.Outcome);
        Assert.Null(observation.BoundManifest);
    }

    private static PlatformInstalledManifestObservation Bind(
        PlatformInstalledPluginHostStatus status = PlatformInstalledPluginHostStatus.Active,
        byte[]? bytes = null) => PlatformInstalledManifestBinder.Bind(
            Snapshot(status: status),
            Snapshot(status: status),
            PlatformInstalledManifestReadResult.Acquired(bytes ?? ManifestBytes(), "Example.Provider"));

    internal static PlatformInstalledPluginSnapshot Snapshot(
        Guid? pluginId = null,
        string name = "Example Provider",
        Version? version = null,
        PlatformInstalledPluginHostStatus status = PlatformInstalledPluginHostStatus.Active,
        string root = "/plugins/example",
        IReadOnlyList<string>? dllFiles = null) =>
        PlatformInstalledPluginSnapshot.EstablishHostSnapshot(
            pluginId ?? PluginId,
            name,
            version ?? new Version(1, 2, 3, 4),
            status,
            root,
            (dllFiles ?? new[] { "/plugins/example/Example.Provider.dll" }).ToImmutableArray());

    internal static byte[] ManifestBytes(
        string pluginId = "11111111-2222-3333-4444-555555555555",
        string version = "1.2.3.4",
        int platformMin = 1,
        int platformMax = 1,
        int hostMin = 12,
        int hostMax = 12,
        IReadOnlyList<string>? capabilities = null)
    {
        capabilities ??= Array.Empty<string>();
        var quotedCapabilities = string.Join(',', capabilities.Select(value => "\"" + value + "\""));
        return Encoding.UTF8.GetBytes("{"
            + "\"schemaVersion\":1"
            + ",\"id\":\"org.example.provider\""
            + ",\"pluginId\":\"" + pluginId + "\""
            + ",\"version\":\"" + version + "\""
            + ",\"kind\":\"installed-provider\""
            + ",\"displayName\":\"Example Provider\""
            + ",\"platform\":{\"min\":" + platformMin + ",\"max\":" + platformMax + "}"
            + ",\"host\":{\"minMajor\":" + hostMin + ",\"maxMajor\":" + hostMax + "}"
            + ",\"requestedCapabilities\":[" + quotedCapabilities + "]}");
    }
}
