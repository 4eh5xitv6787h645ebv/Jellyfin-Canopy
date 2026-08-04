using System;
using System.Collections.Immutable;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Runtime.CompilerServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

[Collection("Installed manifest filesystem isolation")]
public sealed class PlatformInstalledManifestFileReaderTests
{
    private static readonly byte[] HonestBytes = Encoding.UTF8.GetBytes("{\"honest\":true}");
    private static readonly byte[] OutsideSentinel = Encoding.UTF8.GetBytes("OUTSIDE-SENTINEL");

    [Fact]
    public async Task OrdinaryExactMaximumAndMaximumPlusOneAreBounded()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();

        tree.WriteManifest(HonestBytes);
        var ordinary = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, ordinary.Outcome);
        Assert.Equal(HonestBytes, ordinary.Bytes);
        Assert.StartsWith("sha256:", ordinary.AssemblyIdentity, StringComparison.Ordinal);
        Assert.Equal(71, ordinary.AssemblyIdentity!.Length);

        var exactBytes = new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes];
        Array.Fill(exactBytes, (byte)'x');
        tree.WriteManifest(exactBytes);
        var exact = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, exact.Outcome);
        Assert.Equal(PlatformExtensionManifestBounds.MaximumDocumentBytes, exact.Bytes.Length);

        tree.WriteManifest(new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes + 1]);
        var over = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.DocumentTooLarge, over.Outcome);
        Assert.Empty(over.Bytes);
        Assert.Null(over.AssemblyIdentity);
    }

    [Fact]
    public async Task AbsentAndAssemblyFailuresHaveClosedEmptyResults()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();

        AssertRejected(
            PlatformInstalledManifestOutcome.ManifestAbsent,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));

        tree.WriteManifest(HonestBytes);
        var withDllMetadata = await reader.ReadAsync(
            tree.Snapshot(),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, withDllMetadata.Outcome);
        Assert.StartsWith(
            "sha256:",
            withDllMetadata.AssemblyIdentity,
            StringComparison.Ordinal);

        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(
                    dllFiles: ImmutableArray.Create(tree.OutsideFile)),
                CancellationToken.None));

        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyUnavailable,
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: ImmutableArray<string>.Empty),
                CancellationToken.None));

        var escapingDll = Path.Combine(tree.Root, "Escaping.Provider.dll");
        File.CreateSymbolicLink(escapingDll, tree.OutsideFile);
        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: ImmutableArray.Create(escapingDll)),
                CancellationToken.None));

        var duplicateDll = Path.Combine(tree.Root, "Duplicate.Provider.dll");
        File.CreateSymbolicLink(duplicateDll, tree.AssemblyPath);
        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: ImmutableArray.Create(
                    tree.AssemblyPath,
                    duplicateDll)),
                CancellationToken.None));
    }

    [Fact]
    public async Task AssemblyFileCountIsExactBoundedAndCancellationDisposesEveryHandle()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var dllFiles = Enumerable.Range(
                0,
                PlatformInstalledManifestLimits.MaximumDllFileCount)
            .Select(index =>
            {
                var path = Path.Combine(tree.Root, $"Provider-{index:D3}.dll");
                File.WriteAllBytes(path, [(byte)index]);
                return path;
            })
            .ToImmutableArray();
        var reader = new PlatformInstalledManifestFileReader();

        var exact = await reader.ReadAsync(
            tree.Snapshot(dllFiles: dllFiles),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, exact.Outcome);

        var overBound = dllFiles.Add(tree.AssemblyPath);
        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: overBound),
                CancellationToken.None));

        using var cancellation = new CancellationTokenSource();
        var descriptorsBefore = DescriptorCount();
        reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: null,
            afterManifestRead: null,
            afterAssemblyMetadataOpen: cancellation.Cancel);
        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: dllFiles),
                cancellation.Token));
        Assert.InRange(DescriptorCount() - descriptorsBefore, -2, 2);
    }

    [Fact]
    public async Task BackslashMixedSeparatorAndTraversalMetadataFailClosed()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var reader = new PlatformInstalledManifestFileReader();
        var rootName = Path.GetFileName(tree.Root);

        AssertRejected(
            PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot,
            await reader.ReadAsync(
                tree.Snapshot(reportedRoot: tree.Root + "\\..\\" + rootName),
                CancellationToken.None));

        var assemblyTraversal = Path.Combine(tree.Root, "nested")
            + "\\..\\"
            + Path.GetFileName(tree.AssemblyPath);
        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(
                    dllFiles: ImmutableArray.Create(assemblyTraversal)),
                CancellationToken.None));

        var dllTraversal = tree.Root + "\\nested\\..\\" + Path.GetFileName(tree.AssemblyPath);
        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: ImmutableArray.Create(dllTraversal)),
                CancellationToken.None));

        foreach (var unsafeRoot in new[]
        {
            tree.Root + Path.DirectorySeparatorChar + ".",
            Path.DirectorySeparatorChar + Path.DirectorySeparatorChar.ToString()
                + tree.Root.TrimStart(Path.DirectorySeparatorChar),
            @"\\?\" + tree.Root.TrimStart(Path.DirectorySeparatorChar),
            Path.GetPathRoot(tree.Root)!,
        })
        {
            AssertRejected(
                PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot,
                await reader.ReadAsync(
                    tree.Snapshot(reportedRoot: unsafeRoot),
                    CancellationToken.None));
        }

        var dottedAssembly = Path.Combine(tree.Root, ".", Path.GetFileName(tree.AssemblyPath));
        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(
                    dllFiles: ImmutableArray.Create(dottedAssembly)),
                CancellationToken.None));
    }

    [Fact]
    public async Task SymlinkedRootAndEquivalentDllLinkBindByFinalDescriptorIdentity()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var direct = await new PlatformInstalledManifestFileReader().ReadAsync(
            tree.Snapshot(),
            CancellationToken.None);
        var rootLink = Path.Combine(Path.GetDirectoryName(tree.Root)!, "plugin-link");
        File.CreateSymbolicLink(rootLink, tree.Root);
        var dllLink = Path.Combine(tree.Root, "Equivalent.Provider.dll");
        File.CreateSymbolicLink(dllLink, tree.AssemblyPath);

        var result = await new PlatformInstalledManifestFileReader().ReadAsync(
            tree.Snapshot(
                reportedRoot: rootLink,
                dllFiles: ImmutableArray.Create(dllLink)),
            CancellationToken.None);

        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, result.Outcome);
        Assert.Equal(HonestBytes, result.Bytes);
        Assert.Equal(direct.AssemblyIdentity, result.AssemblyIdentity);
    }

    [Fact]
    public async Task AssemblySetIdentityIsIndependentOfDllInventoryOrder()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var secondDll = Path.Combine(tree.Root, "Second.Provider.dll");
        File.WriteAllBytes(secondDll, [4, 5, 6]);
        var reader = new PlatformInstalledManifestFileReader();

        var first = await reader.ReadAsync(
            tree.Snapshot(
                dllFiles: ImmutableArray.Create(tree.AssemblyPath, secondDll)),
            CancellationToken.None);
        var reversed = await reader.ReadAsync(
            tree.Snapshot(
                dllFiles: ImmutableArray.Create(secondDll, tree.AssemblyPath)),
            CancellationToken.None);

        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, first.Outcome);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, reversed.Outcome);
        Assert.Equal(first.AssemblyIdentity, reversed.AssemblyIdentity);
    }

    [Fact]
    public async Task MetadataHandleSurvivesLeafReplacementButPostReadNameAgreementRejectsIt()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var originalTarget = Path.Combine(tree.Root, "original.json");
        var replacementTarget = Path.Combine(tree.Root, "replacement.json");
        File.WriteAllBytes(originalTarget, HonestBytes);
        File.WriteAllBytes(replacementTarget, OutsideSentinel);
        File.CreateSymbolicLink(tree.ManifestPath, originalTarget);
        var reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: () => ReplaceSymbolicLink(
                tree.ManifestPath,
                replacementTarget),
            afterManifestRead: null);

        AssertRejected(
            PlatformInstalledManifestOutcome.ReadChanged,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
    }

    [Fact]
    public async Task DeletingTheFixedEntryAfterReadFailsPostReadNameAgreement()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var target = Path.Combine(tree.Root, "manifest-target.json");
        File.WriteAllBytes(target, HonestBytes);
        File.CreateSymbolicLink(tree.ManifestPath, target);
        var reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: null,
            afterManifestRead: () => File.Delete(tree.ManifestPath));

        AssertRejected(
            PlatformInstalledManifestOutcome.ReadChanged,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
    }

    [Fact]
    public async Task RetargetingASymlinkedRootAfterReadFailsRootIdentityAgreement()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var parent = Path.GetDirectoryName(tree.Root)!;
        var rootLink = Path.Combine(parent, "plugin-link");
        var replacementRoot = Directory.CreateDirectory(
            Path.Combine(parent, "replacement-plugin")).FullName;
        File.CreateSymbolicLink(rootLink, tree.Root);
        var reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: null,
            afterManifestRead: () => ReplaceSymbolicLink(rootLink, replacementRoot));

        AssertRejected(
            PlatformInstalledManifestOutcome.ReadChanged,
            await reader.ReadAsync(
                tree.Snapshot(reportedRoot: rootLink),
                CancellationToken.None));
    }

    [Fact]
    public async Task RetargetingAReportedDllAfterAssemblyOpenFailsFinalNameAgreement()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var replacementDll = Path.Combine(tree.Root, "Replacement.Provider.dll");
        File.WriteAllBytes(replacementDll, [9, 8, 7]);
        var reportedDll = Path.Combine(tree.Root, "Reported.Provider.dll");
        File.CreateSymbolicLink(reportedDll, tree.AssemblyPath);
        var reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: null,
            afterManifestRead: null,
            afterAssemblyMetadataOpen: () => ReplaceSymbolicLink(reportedDll, replacementDll));

        AssertRejected(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            await reader.ReadAsync(
                tree.Snapshot(dllFiles: ImmutableArray.Create(reportedDll)),
                CancellationToken.None));
    }

    [Fact]
    public async Task RetargetingAReportedRootDuringAssemblyVerificationFailsFinalAgreement()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var parent = Path.GetDirectoryName(tree.Root)!;
        var reportedRoot = Path.Combine(parent, "reported-plugin-root");
        var replacementRoot = Directory.CreateDirectory(
            Path.Combine(parent, "replacement-after-assembly")).FullName;
        File.CreateSymbolicLink(reportedRoot, tree.Root);
        var reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: null,
            afterManifestRead: null,
            afterAssemblyMetadataOpen: () => ReplaceSymbolicLink(reportedRoot, replacementRoot));

        AssertRejected(
            PlatformInstalledManifestOutcome.ReadChanged,
            await reader.ReadAsync(
                tree.Snapshot(reportedRoot: reportedRoot),
                CancellationToken.None));
    }

    [Fact]
    public async Task MutatingTheManifestDuringAssemblyVerificationFailsFinalStableAgreement()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var reader = new PlatformInstalledManifestFileReader(
            afterManifestMetadataOpen: null,
            afterManifestRead: null,
            afterAssemblyMetadataOpen: () => tree.WriteManifest(OutsideSentinel));

        AssertRejected(
            PlatformInstalledManifestOutcome.ReadChanged,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
    }

    [Fact]
    public async Task ABindMountedFixedLeafIsRejectedWhenTheTestHostAllowsMounting()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        const ulong bindMount = 4096;
        if (Mount(tree.OutsideFile, tree.ManifestPath, null, bindMount, null) != 0)
        {
            return;
        }

        try
        {
            AssertRejected(
                PlatformInstalledManifestOutcome.UnsafeTarget,
                await new PlatformInstalledManifestFileReader().ReadAsync(
                    tree.Snapshot(),
                    CancellationToken.None));
        }
        finally
        {
            Unmount(tree.ManifestPath, 0);
        }
    }

    [Fact]
    public async Task VerifiableInRootLinksWorkAndEscapesBrokenLinksAndCyclesFailClosed()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();
        var manifestPath = tree.ManifestPath;
        var target = Path.Combine(tree.Root, "manifest-target.json");
        File.WriteAllBytes(target, HonestBytes);

        File.CreateSymbolicLink(manifestPath, target);
        var inside = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, inside.Outcome);
        Assert.Equal(HonestBytes, inside.Bytes);

        File.Delete(manifestPath);
        var secondHop = Path.Combine(tree.Root, "second-hop.json");
        File.CreateSymbolicLink(secondHop, target);
        File.CreateSymbolicLink(manifestPath, secondHop);
        var multiHopInside = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, multiHopInside.Outcome);

        File.Delete(manifestPath);
        File.CreateSymbolicLink(manifestPath, tree.OutsideFile);
        AssertRejected(
            PlatformInstalledManifestOutcome.UnsafeTarget,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));

        File.Delete(manifestPath);
        var nested = Directory.CreateDirectory(Path.Combine(tree.Root, "nested")).FullName;
        var directoryHop = Path.Combine(tree.Root, "directory-hop");
        File.CreateSymbolicLink(directoryHop, nested);
        File.CreateSymbolicLink(Path.Combine(nested, "escape.json"), tree.OutsideFile);
        File.CreateSymbolicLink(manifestPath, Path.Combine(directoryHop, "escape.json"));
        AssertRejected(
            PlatformInstalledManifestOutcome.UnsafeTarget,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));

        File.Delete(manifestPath);
        File.CreateSymbolicLink(manifestPath, Path.Combine(tree.Root, "missing.json"));
        AssertRejected(
            PlatformInstalledManifestOutcome.UnsafeTarget,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));

        File.Delete(manifestPath);
        var cycle = Path.Combine(tree.Root, "cycle.json");
        File.CreateSymbolicLink(manifestPath, cycle);
        File.CreateSymbolicLink(cycle, manifestPath);
        AssertRejected(
            PlatformInstalledManifestOutcome.UnsafeTarget,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
    }

    [Fact]
    public async Task DirectoryFifoSocketAndAvailableDeviceAreRejectedWithoutBlockingOrFdGrowth()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();

        Directory.CreateDirectory(tree.ManifestPath);
        AssertRejected(
            PlatformInstalledManifestOutcome.NotRegularFile,
            await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
        Directory.Delete(tree.ManifestPath);

        Assert.Equal(0, MakeFifo(tree.ManifestPath, Convert.ToUInt32("600", 8)));
        var descriptorsBefore = DescriptorCount();
        var stopwatch = Stopwatch.StartNew();
        for (var index = 0; index < 64; index++)
        {
            AssertRejected(
                PlatformInstalledManifestOutcome.NotRegularFile,
                await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
        }

        stopwatch.Stop();
        var descriptorsAfter = DescriptorCount();
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(2), stopwatch.Elapsed.ToString());
        Assert.InRange(descriptorsAfter - descriptorsBefore, -2, 2);
        File.Delete(tree.ManifestPath);

        using (var socket = new Socket(AddressFamily.Unix, SocketType.Stream, ProtocolType.Unspecified))
        {
            socket.Bind(new UnixDomainSocketEndPoint(tree.ManifestPath));
            AssertRejected(
                PlatformInstalledManifestOutcome.NotRegularFile,
                await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
        }

        File.Delete(tree.ManifestPath);

        const uint characterDeviceWithOwnerReadWrite = 0x2000 | 0x180;
        const ulong nullDevice = 0x103;
        if (MakeNode(tree.ManifestPath, characterDeviceWithOwnerReadWrite, nullDevice) == 0)
        {
            AssertRejected(
                PlatformInstalledManifestOutcome.NotRegularFile,
                await reader.ReadAsync(tree.Snapshot(), CancellationToken.None));
        }
    }

    [Fact]
    public async Task S16SwapRaceNeverReturnsOutsideSentinelBytes()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();
        var honestTarget = Path.Combine(tree.Root, "honest.json");
        File.WriteAllBytes(honestTarget, HonestBytes);
        File.CreateSymbolicLink(tree.ManifestPath, honestTarget);

        using var stop = new CancellationTokenSource();
        var writer = Task.Run(() => SwapManifestLinks(tree, honestTarget, stop.Token));
        var acquired = 0;
        try
        {
            for (var index = 0; index < 2000; index++)
            {
                var result = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
                if (result.Outcome == PlatformInstalledManifestOutcome.Acquired)
                {
                    acquired++;
                    Assert.Equal(HonestBytes, result.Bytes);
                    Assert.NotEqual(OutsideSentinel, result.Bytes.ToArray());
                }
                else
                {
                    Assert.Empty(result.Bytes);
                }
            }
        }
        finally
        {
            stop.Cancel();
            await writer;
        }

        Assert.True(acquired > 0);
    }

    [Fact]
    public async Task ConcurrentContentMutationNeverPublishesAChangedOrPartialRead()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();
        tree.WriteManifest(new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes]);

        using var stream = new FileStream(
            tree.ManifestPath,
            FileMode.Open,
            FileAccess.Write,
            FileShare.ReadWrite | FileShare.Delete);
        using var stop = new CancellationTokenSource();
        var writer = Task.Run(() => MutateFile(stream, stop.Token));
        var changed = 0;
        try
        {
            for (var index = 0; index < 128; index++)
            {
                var result = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
                if (result.Outcome == PlatformInstalledManifestOutcome.ReadChanged)
                {
                    changed++;
                }
                else if (result.Outcome == PlatformInstalledManifestOutcome.Acquired)
                {
                    Assert.Equal(
                        PlatformExtensionManifestBounds.MaximumDocumentBytes,
                        result.Bytes.Length);
                }
                else
                {
                    Assert.Contains(
                        result.Outcome,
                        new[]
                        {
                            PlatformInstalledManifestOutcome.DocumentTooLarge,
                            PlatformInstalledManifestOutcome.ReadFailed,
                        });
                }
            }
        }
        finally
        {
            stop.Cancel();
            await writer;
        }

        Assert.True(changed > 0);
    }

    [Fact]
    public async Task ConcurrentGrowthAndShrinkNeverBypassTheCapOrPublishPartialBytes()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        var reader = new PlatformInstalledManifestFileReader();
        var smaller = PlatformExtensionManifestBounds.MaximumDocumentBytes / 2;
        tree.WriteManifest(new byte[smaller]);

        using var stream = new FileStream(
            tree.ManifestPath,
            FileMode.Open,
            FileAccess.Write,
            FileShare.ReadWrite | FileShare.Delete);
        using var stop = new CancellationTokenSource();
        var writer = Task.Run(() => GrowAndShrinkFile(stream, smaller, stop.Token));
        var rejectedChanges = 0;
        try
        {
            for (var index = 0; index < 128; index++)
            {
                var result = await reader.ReadAsync(tree.Snapshot(), CancellationToken.None);
                switch (result.Outcome)
                {
                    case PlatformInstalledManifestOutcome.Acquired:
                        Assert.InRange(
                            result.Bytes.Length,
                            0,
                            PlatformExtensionManifestBounds.MaximumDocumentBytes);
                        break;
                    case PlatformInstalledManifestOutcome.ReadChanged:
                    case PlatformInstalledManifestOutcome.DocumentTooLarge:
                    case PlatformInstalledManifestOutcome.ReadFailed:
                        rejectedChanges++;
                        Assert.Empty(result.Bytes);
                        break;
                    default:
                        Assert.Fail("Unexpected growth/shrink outcome: " + result.Outcome);
                        break;
                }
            }
        }
        finally
        {
            stop.Cancel();
            await writer;
        }

        Assert.True(rejectedChanges > 0);
    }

    [Fact]
    public void ReadersAreTheOnlyAcquisitionFilesOwningIoPathsAndNativeHandles()
    {
        var platformRoot = ProductionPlatformRoot();
        var acquisitionFiles = Directory.EnumerateFiles(
            platformRoot,
            "PlatformInstalledManifest*.cs",
            SearchOption.TopDirectoryOnly).ToArray();
        var ownershipTokens = new[]
        {
            "using System.IO;",
            "DllImport(",
            "SafeHandle",
            "SafeUnixDescriptor",
            "Path.",
            "OpenAt(",
        };
        var owners = acquisitionFiles
            .Where(file => ownershipTokens.Any(token => File.ReadAllText(file).Contains(
                token,
                StringComparison.Ordinal)))
            .Select(Path.GetFileName)
            .Order(StringComparer.Ordinal)
            .ToArray();

        Assert.Equal(
            new[]
            {
                "PlatformInstalledManifestFileReader.cs",
                "PlatformInstalledManifestWindowsReader.cs",
            },
            owners);
        var reader = File.ReadAllText(Path.Combine(
            platformRoot,
            "PlatformInstalledManifestFileReader.cs"));
        Assert.DoesNotContain("Task.Run", reader, StringComparison.Ordinal);
        Assert.DoesNotContain("Directory.Enumerate", reader, StringComparison.Ordinal);
        Assert.Contains("OpenNonBlocking", reader, StringComparison.Ordinal);
        Assert.Contains("/proc/self/fd/", reader, StringComparison.Ordinal);
        Assert.Contains("statx", reader, StringComparison.Ordinal);
        Assert.Contains("fstatfs", reader, StringComparison.Ordinal);
        Assert.Contains("SupportedLocalFileSystemTypes", reader, StringComparison.Ordinal);
        Assert.Contains("AssemblySetIdentityDomain", reader, StringComparison.Ordinal);
        Assert.DoesNotContain("InstanceAssembly", reader, StringComparison.Ordinal);
        Assert.DoesNotContain("GetType()", reader, StringComparison.Ordinal);
        Assert.Contains(
            nameof(PlatformExtensionManifestParser.ManifestFileName),
            reader,
            StringComparison.Ordinal);
    }

    [Fact]
    public async Task PreCancelledReadPublishesNothingAndThrowsCancellation()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }

        using var tree = new ReaderTree();
        tree.WriteManifest(HonestBytes);
        var reader = new PlatformInstalledManifestFileReader();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(async () =>
            await reader.ReadAsync(tree.Snapshot(), cancellation.Token));
    }

    private static void SwapManifestLinks(
        ReaderTree tree,
        string honestTarget,
        CancellationToken cancellationToken)
    {
        var iteration = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            var target = iteration++ % 2 == 0 ? honestTarget : tree.OutsideFile;
            var temporary = Path.Combine(tree.Root, ".swap-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.CreateSymbolicLink(temporary, target);
                File.Move(temporary, tree.ManifestPath, overwrite: true);
            }
            catch (IOException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            finally
            {
                try
                {
                    File.Delete(temporary);
                }
                catch (IOException)
                {
                    // A successful atomic rename consumes the temporary name.
                }
            }
        }
    }

    private static void MutateFile(FileStream stream, CancellationToken cancellationToken)
    {
        var value = (byte)0;
        var buffer = new byte[1];
        while (!cancellationToken.IsCancellationRequested)
        {
            buffer[0] = value++;
            RandomAccess.Write(stream.SafeFileHandle, buffer, 0);
        }
    }

    private static void GrowAndShrinkFile(
        FileStream stream,
        int smaller,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            stream.SetLength(PlatformExtensionManifestBounds.MaximumDocumentBytes + 1L);
            stream.Flush(flushToDisk: false);
            stream.SetLength(smaller);
            stream.Flush(flushToDisk: false);
        }
    }

    private static void ReplaceSymbolicLink(string linkPath, string target)
    {
        var replacement = linkPath + ".replacement";
        File.Delete(replacement);
        File.CreateSymbolicLink(replacement, target);
        if (Rename(replacement, linkPath) != 0)
        {
            throw new IOException("Could not atomically replace the test link.");
        }
    }

    private static int DescriptorCount() => Directory.GetFileSystemEntries("/proc/self/fd").Length;

    private static string ProductionPlatformRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Platform"));

    private static void AssertRejected(
        PlatformInstalledManifestOutcome expected,
        PlatformInstalledManifestReadResult result)
    {
        Assert.Equal(expected, result.Outcome);
        Assert.Empty(result.Bytes);
        Assert.Null(result.AssemblyIdentity);
    }

    private sealed class ReaderTree : IDisposable
    {
        private readonly string _container;

        internal ReaderTree()
        {
            _container = Directory.CreateTempSubdirectory("canopy-manifest-reader-").FullName;
            Root = Directory.CreateDirectory(Path.Combine(_container, "plugin")).FullName;
            AssemblyPath = Path.Combine(Root, "Example.Provider.dll");
            File.WriteAllBytes(AssemblyPath, [1, 2, 3]);
            OutsideFile = Path.Combine(_container, "outside.json");
            File.WriteAllBytes(OutsideFile, OutsideSentinel);
        }

        internal string Root { get; }

        internal string ManifestPath => Path.Combine(
            Root,
            PlatformExtensionManifestParser.ManifestFileName);

        internal string AssemblyPath { get; }

        internal string OutsideFile { get; }

        internal void WriteManifest(byte[] bytes)
        {
            if (Directory.Exists(ManifestPath))
            {
                Directory.Delete(ManifestPath);
            }
            else
            {
                File.Delete(ManifestPath);
            }

            File.WriteAllBytes(ManifestPath, bytes);
        }

        internal PlatformInstalledPluginSnapshot Snapshot(
            ImmutableArray<string>? dllFiles = null,
            string? reportedRoot = null) =>
            PlatformInstalledPluginSnapshot.EstablishHostSnapshot(
                Guid.Parse("11111111-2222-3333-4444-555555555555"),
                "Example Provider",
                new Version(1, 0),
                PlatformInstalledPluginHostStatus.Active,
                reportedRoot ?? Root,
                dllFiles ?? ImmutableArray.Create(AssemblyPath));

        public void Dispose()
        {
            try
            {
                Directory.Delete(_container, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort cleanup for race fixtures on exceptional test exits.
            }
        }
    }

#pragma warning disable SYSLIB1054 // Linux-only fixture creation; generated marshalling is unnecessary.
    [DllImport("libc", EntryPoint = "mkfifo", SetLastError = true)]
    private static extern int MakeFifo(string path, uint mode);

    [DllImport("libc", EntryPoint = "mknod", SetLastError = true)]
    private static extern int MakeNode(string path, uint mode, ulong device);

    [DllImport("libc", EntryPoint = "mount", SetLastError = true)]
    private static extern int Mount(
        string source,
        string target,
        string? filesystemType,
        ulong flags,
        string? data);

    [DllImport("libc", EntryPoint = "umount2", SetLastError = true)]
    private static extern int Unmount(string target, int flags);

    [DllImport("libc", EntryPoint = "rename", SetLastError = true)]
    private static extern int Rename(string oldPath, string newPath);
#pragma warning restore SYSLIB1054
}

[CollectionDefinition("Installed manifest filesystem isolation", DisableParallelization = true)]
public sealed class InstalledManifestFilesystemIsolationCollection
{
}
