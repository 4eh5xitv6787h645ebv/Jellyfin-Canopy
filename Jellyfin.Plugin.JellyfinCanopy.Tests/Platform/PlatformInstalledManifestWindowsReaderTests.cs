using System;
using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Win32.SafeHandles;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformInstalledManifestWindowsReaderTests
{
    private const string ReaderFileName = "PlatformInstalledManifestWindowsReader.cs";

    private static readonly string[] ForbiddenTokens =
    {
        "Task.Run", "File.ReadAll", "FileStream", "Directory.Enumerate", "Directory.GetFiles",
        "HttpClient", "System.Net", "IConfiguration", "IServiceCollection", "AtomicFile",
        "Registry", "Approval", "Grant", "PlatformActorFactory", "Assembly.Load", "Activator",
        "ProviderInvocation", "Controller", "Route(", "IHostedService", "BackgroundService",
        "AddHostedService", "Android",
    };

    [Fact]
    public void ReadIsTheSingleInternalStaticBoundary()
    {
        var type = typeof(PlatformInstalledManifestWindowsReader);
        Assert.True(type.IsAbstract && type.IsSealed);
        Assert.False(type.IsPublic);
        var read = Assert.Single(type.GetMethods(
            BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.DeclaredOnly),
            method => method.Name == "Read");
        Assert.Equal(typeof(PlatformInstalledManifestReadResult), read.ReturnType);
        Assert.Equal(
            new[] { typeof(PlatformInstalledPluginSnapshot), typeof(CancellationToken) },
            read.GetParameters().Select(parameter => parameter.ParameterType));
        Assert.DoesNotContain(read.GetParameters(), parameter => parameter.ParameterType == typeof(string));
    }

    [Fact]
    public void LinuxCoverageExclusionIsBackedByARealWindowsCiJob()
    {
        Assert.NotNull(typeof(PlatformInstalledManifestWindowsReader)
            .GetCustomAttribute<ExcludeFromCodeCoverageAttribute>());
        var workflow = File.ReadAllText(Path.Combine(RepositoryRoot(), ".github", "workflows", "build.yml"));
        Assert.Contains("windows-manifest-tests:", workflow, StringComparison.Ordinal);
        Assert.Contains("runs-on: windows-latest", workflow, StringComparison.Ordinal);
        Assert.Contains("FullyQualifiedName~PlatformInstalledManifestWindowsReaderTests", workflow,
            StringComparison.Ordinal);
    }

    [Fact]
    public void NonWindowsInvocationFailsClosedBeforeAnyNativeCall()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var result = PlatformInstalledManifestWindowsReader.Read(Snapshot(), CancellationToken.None);

        Assert.Equal(PlatformInstalledManifestOutcome.DescriptorUnverifiable, result.Outcome);
        Assert.Empty(result.Bytes);
        Assert.Null(result.AssemblyIdentity);
    }

    [Fact]
    public void NativeImportsAreExactSafeHandleWindowsContracts()
    {
        var type = typeof(PlatformInstalledManifestWindowsReader);
        foreach (var methodName in new[]
        {
            "CreateFileW", "ReOpenFile", "GetFinalPathNameByHandleW", "GetFileType",
            "GetDriveTypeW",
            "GetFileInformationByHandleExIdentity", "GetFileInformationByHandleExBasic",
            "GetFileInformationByHandleExStandard", "ReadFile", "CancelIoEx", "GetOverlappedResult",
        })
        {
            var method = type.GetMethod(methodName, BindingFlags.Static | BindingFlags.NonPublic);
            Assert.NotNull(method);
            var import = method!.GetCustomAttribute<DllImportAttribute>();
            Assert.NotNull(import);
            Assert.Equal("kernel32.dll", import!.Value);
            Assert.True(import.ExactSpelling);
            Assert.True(import.SetLastError);
        }

        Assert.Equal(typeof(SafeFileHandle), Method("CreateFileW").ReturnType);
        Assert.Equal(typeof(SafeFileHandle), Method("ReOpenFile").ReturnType);
        Assert.Equal(typeof(SafeFileHandle), Method("ReOpenFile").GetParameters()[0].ParameterType);
        Assert.Equal(typeof(SafeFileHandle), Method("ReadFile").GetParameters()[0].ParameterType);
        Assert.Equal(typeof(SafeFileHandle), Method("CancelIoEx").GetParameters()[0].ParameterType);
        Assert.Equal(typeof(SafeFileHandle), Method("GetOverlappedResult").GetParameters()[0].ParameterType);
        Assert.Equal(typeof(IntPtr), Method("ReadFile").GetParameters()[4].ParameterType);
        Assert.Equal(typeof(IntPtr), Method("CancelIoEx").GetParameters()[1].ParameterType);

        MethodInfo Method(string name) => type.GetMethod(name, BindingFlags.Static | BindingFlags.NonPublic)!;
    }

    [Fact]
    public void NativeIdentityMetadataAndOverlappedLayoutsArePinned()
    {
        var nested = typeof(PlatformInstalledManifestWindowsReader).GetNestedTypes(
            BindingFlags.NonPublic);
        Assert.Equal(16, Size("NativeFileId128"));
        Assert.Equal(24, Size("NativeFileIdInfo"));
        Assert.Equal(40, Size("NativeFileBasicInfo"));
        Assert.Equal(24, Size("NativeFileStandardInfo"));
        Assert.Equal(IntPtr.Size == 8 ? 32 : 20, Size("NativeOverlappedData"));

        int Size(string name) => Marshal.SizeOf(nested.Single(type => type.Name == name));
    }

    [Fact]
    public void HandleVerificationOrderingAndBoundedCancellationArePresent()
    {
        var code = Code(SourceFile());
        var readOwner = code[..code.IndexOf(
            "private static AssemblyVerification VerifyAssembly",
            StringComparison.Ordinal)];

        AssertOrdered(
            readOwner,
            "rootHandle = CreateFileW",
            "TryGetFinalPath(rootHandle",
            "manifestMetadataHandle = CreateFileW",
            "TryGetFinalPath(manifestMetadataHandle",
            "manifestReadHandle = ReOpenFile",
            "ReadBoundedOverlapped",
            "FixedEntryStillNamesStableObject",
            "RootStillNamesObject",
            "VerifyAssembly");
        Assert.Contains("MaximumDocumentBytes + 1", code, StringComparison.Ordinal);
        Assert.Contains("FileFlagOverlapped", code, StringComparison.Ordinal);
        Assert.Contains("CancelIoEx", code, StringComparison.Ordinal);
        Assert.Contains("GetOverlappedResult", code, StringComparison.Ordinal);
        Assert.Contains("GetFinalPathNameByHandleW", code, StringComparison.Ordinal);
        Assert.Contains("GetFileInformationByHandleEx", code, StringComparison.Ordinal);
        Assert.Contains("VolumeSerialNumber", code, StringComparison.Ordinal);
        Assert.Contains("GetDriveTypeW", code, StringComparison.Ordinal);
        Assert.Contains("DriveFixed", code, StringComparison.Ordinal);
        Assert.Contains("foreach (var reportedDll in snapshot.DllFiles)", code, StringComparison.Ordinal);
        Assert.True(
            code.IndexOf("snapshot.DllFiles.Length > PlatformInstalledManifestLimits.MaximumDllFileCount", StringComparison.Ordinal)
            < code.IndexOf("new List<SafeFileHandle>(snapshot.DllFiles.Length)", StringComparison.Ordinal));
        Assert.Contains("verifiedDlls.Add(new VerifiedDll(", code, StringComparison.Ordinal);
        Assert.Contains("FixedEntryStillNamesStableObject", code, StringComparison.Ordinal);
        Assert.True(
            readOwner.LastIndexOf("FixedEntryStillNamesStableObject", StringComparison.Ordinal)
            > readOwner.IndexOf("VerifyAssembly(snapshot", StringComparison.Ordinal));
        Assert.Contains("jellyfin-canopy:installed-assembly-set:v1", code, StringComparison.Ordinal);
        Assert.Contains("IncrementalHash.CreateHash(HashAlgorithmName.SHA256)", code, StringComparison.Ordinal);
        Assert.Contains("OrderBy(item => item.CanonicalRelativeName, StringComparer.Ordinal)", code, StringComparison.Ordinal);
        Assert.Contains("foreach (var dllHandle in dllHandles)", code, StringComparison.Ordinal);
        Assert.Contains(nameof(PlatformExtensionManifestParser.ManifestFileName), code, StringComparison.Ordinal);
        Assert.Empty(Forbidden(code));
    }

    [Theory]
    [InlineData("Task.Run(() => File.ReadAllBytes(path))", "Task.Run")]
    [InlineData("services.AddHostedService<ManifestWorker>();", "AddHostedService")]
    [InlineData("[Route(\"manifest\")] sealed class C : Controller { }", "Controller")]
    [InlineData("Assembly.Load(bytes); Activator.CreateInstance(type);", "Assembly.Load")]
    [InlineData("var approvedGrant = new RegistryApprovalGrant();", "Registry")]
    public void PlantedForbiddenDependenciesAreNamed(string source, string expected) =>
        Assert.Contains(expected, Forbidden(source), StringComparer.OrdinalIgnoreCase);

    [Fact]
    public void SourceHasNoValidateThenManagedOpenFallbackOrRawPathResult()
    {
        var code = Code(SourceFile());
        Assert.DoesNotContain("File.Open", code, StringComparison.Ordinal);
        Assert.DoesNotContain("new FileStream", code, StringComparison.Ordinal);
        Assert.DoesNotContain("ReadAllBytes", code, StringComparison.Ordinal);
        Assert.DoesNotContain("Task.Run", code, StringComparison.Ordinal);
        Assert.DoesNotContain("snapshot.InstanceAssemblyIdentity", code, StringComparison.Ordinal);
        Assert.DoesNotContain("snapshot.InstanceAssemblyPath", code, StringComparison.Ordinal);
        Assert.DoesNotContain("PlatformInstalledManifestReadResult.Acquired(\n                read.Bytes,\n                snapshot.InstanceAssemblyPath",
            code,
            StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("C:\\plugins\\.\\example")]
    [InlineData("C:\\plugins\\..\\example")]
    [InlineData("C:\\plugins\\example:stream")]
    [InlineData("C:plugins\\example")]
    [InlineData("1:\\plugins\\example")]
    [InlineData("\\\\server\\share\\plugins")]
    [InlineData("\\\\?\\C:\\plugins")]
    [InlineData("\\\\.\\C:\\plugins")]
    [InlineData("\\??\\C:\\plugins")]
    [InlineData("\\Device\\HarddiskVolume1\\plugins")]
    public void RawDotAlternateDataStreamUncAndDeviceShapesAreRejectedBeforeNormalization(
        string path)
    {
        var method = typeof(PlatformInstalledManifestWindowsReader).GetMethod(
            "HasUnsafeLexicalShape",
            BindingFlags.Static | BindingFlags.NonPublic)!;

        Assert.True(Assert.IsType<bool>(method.Invoke(null, new object[] { path })));
        Assert.False(Assert.IsType<bool>(method.Invoke(null, new object[] { "C:\\plugins\\example" })));
    }

    [Fact]
    public void WindowsHonestFileAndExactMaximumAreAcquired()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        var honest = PlatformInstalledManifestBindingTests.ManifestBytes();
        tree.WriteManifest(honest);
        var result = PlatformInstalledManifestWindowsReader.Read(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, result.Outcome);
        Assert.Equal(honest, result.Bytes);

        var exact = new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes];
        honest.CopyTo(exact, 0);
        exact.AsSpan(honest.Length).Fill((byte)' ');
        tree.WriteManifest(exact);
        result = PlatformInstalledManifestWindowsReader.Read(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, result.Outcome);
        Assert.Equal(exact.Length, result.Bytes.Length);
    }

    [Fact]
    public void WindowsCapPlusOneFailsBeforePublishingBytes()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        tree.WriteManifest(new byte[PlatformExtensionManifestBounds.MaximumDocumentBytes + 1]);

        var result = PlatformInstalledManifestWindowsReader.Read(tree.Snapshot(), CancellationToken.None);

        Assert.Equal(PlatformInstalledManifestOutcome.DocumentTooLarge, result.Outcome);
        Assert.Empty(result.Bytes);
    }

    [Fact]
    public void WindowsInRootLinkWorksAndOutsideLinkFailsClosed()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        var bytes = PlatformInstalledManifestBindingTests.ManifestBytes();
        var inside = Path.Combine(tree.Root, "inside-manifest.json");
        File.WriteAllBytes(inside, bytes);
        Assert.True(
            TryCreateFileLink(tree.ManifestPath, inside),
            "Windows CI must permit symbolic-link creation so handle containment is exercised.");

        var result = PlatformInstalledManifestWindowsReader.Read(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, result.Outcome);
        File.Delete(tree.ManifestPath);

        File.WriteAllBytes(tree.OutsideManifest, bytes);
        Assert.True(
            TryCreateFileLink(tree.ManifestPath, tree.OutsideManifest),
            "Windows CI must permit symbolic-link creation so escape rejection is exercised.");

        result = PlatformInstalledManifestWindowsReader.Read(tree.Snapshot(), CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.UnsafeTarget, result.Outcome);
        Assert.Empty(result.Bytes);
    }

    [Fact]
    public void WindowsDllInventoryIsHandleVerifiedAndHasDeterministicSetIdentity()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        tree.WriteManifest(PlatformInstalledManifestBindingTests.ManifestBytes());
        var otherDll = Path.Combine(tree.Root, "Other.dll");
        File.WriteAllBytes(otherDll, new byte[] { 7, 8, 9 });

        var firstOrder = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray.Create(tree.AssemblyPath, otherDll)),
            CancellationToken.None);
        var secondOrder = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray.Create(otherDll, tree.AssemblyPath)),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, firstOrder.Outcome);
        Assert.Equal(firstOrder.AssemblyIdentity, secondOrder.AssemblyIdentity);
        Assert.StartsWith("dll-set-sha256:", firstOrder.AssemblyIdentity, StringComparison.Ordinal);
        Assert.DoesNotContain("Example.Provider", firstOrder.AssemblyIdentity, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(tree.Root, firstOrder.AssemblyIdentity, StringComparison.OrdinalIgnoreCase);

        var outsideDll = Path.Combine(Path.GetDirectoryName(tree.Root)!, "outside", "Outside.dll");
        File.WriteAllBytes(outsideDll, new byte[] { 10, 11, 12 });
        var outside = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray.Create(outsideDll)),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.AssemblyMismatch, outside.Outcome);

        var alias = Path.Combine(tree.Root, "Alias.dll");
        var direct = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray.Create(tree.AssemblyPath)),
            CancellationToken.None);
        Assert.True(
            TryCreateFileLink(alias, tree.AssemblyPath),
            "Windows CI must permit symbolic-link creation so DLL alias identity is exercised.");

        var inRootAlias = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray.Create(alias)),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.Acquired, inRootAlias.Outcome);
        Assert.Equal(direct.AssemblyIdentity, inRootAlias.AssemblyIdentity);
    }

    [Fact]
    public void WindowsDllDirectoryEscapesBrokenLinksAndCyclesFailClosed()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        tree.WriteManifest(PlatformInstalledManifestBindingTests.ManifestBytes());
        var outsideDirectory = Path.GetDirectoryName(tree.OutsideManifest)!;
        var outsideDll = Path.Combine(outsideDirectory, "Outside.Provider.dll");
        File.WriteAllBytes(outsideDll, [5, 4, 3]);

        var escapeDirectory = Path.Combine(tree.Root, "escape-directory");
        Assert.True(
            TryCreateDirectoryLink(escapeDirectory, outsideDirectory),
            "Windows CI must permit directory links so component escapes are exercised.");
        Assert.Equal(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            PlatformInstalledManifestWindowsReader.Read(
                tree.Snapshot(ImmutableArray.Create(Path.Combine(escapeDirectory, "Outside.Provider.dll"))),
                CancellationToken.None).Outcome);

        Directory.Delete(escapeDirectory);
        var secondHop = Path.Combine(tree.Root, "second-hop");
        var firstHop = Path.Combine(tree.Root, "first-hop");
        Assert.True(TryCreateDirectoryLink(secondHop, outsideDirectory));
        Assert.True(TryCreateDirectoryLink(firstHop, secondHop));
        Assert.Equal(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            PlatformInstalledManifestWindowsReader.Read(
                tree.Snapshot(ImmutableArray.Create(Path.Combine(firstHop, "Outside.Provider.dll"))),
                CancellationToken.None).Outcome);

        Directory.Delete(firstHop);
        Directory.Delete(secondHop);
        var broken = Path.Combine(tree.Root, "Broken.Provider.dll");
        Assert.True(TryCreateFileLink(broken, Path.Combine(tree.Root, "missing.dll")));
        Assert.Equal(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            PlatformInstalledManifestWindowsReader.Read(
                tree.Snapshot(ImmutableArray.Create(broken)),
                CancellationToken.None).Outcome);

        File.Delete(broken);
        var cycleA = Path.Combine(tree.Root, "CycleA.Provider.dll");
        var cycleB = Path.Combine(tree.Root, "CycleB.Provider.dll");
        Assert.True(TryCreateFileLink(cycleA, cycleB));
        Assert.True(TryCreateFileLink(cycleB, cycleA));
        Assert.Equal(
            PlatformInstalledManifestOutcome.AssemblyMismatch,
            PlatformInstalledManifestWindowsReader.Read(
                tree.Snapshot(ImmutableArray.Create(cycleA)),
                CancellationToken.None).Outcome);
    }

    [Fact]
    public async Task WindowsConcurrentValidFileOutsideLinkSwapNeverPublishesOutsideBytes()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        var honest = PlatformInstalledManifestBindingTests.ManifestBytes();
        var outside = Encoding.UTF8.GetBytes("OUTSIDE-WINDOWS-SENTINEL");
        var honestTarget = Path.Combine(tree.Root, "honest-manifest.json");
        File.WriteAllBytes(honestTarget, honest);
        File.WriteAllBytes(tree.OutsideManifest, outside);
        Assert.True(TryCreateFileLink(tree.ManifestPath, honestTarget));

        using var stop = new CancellationTokenSource();
        var honestSwaps = 0;
        var outsideSwaps = 0;
        var writer = Task.Run(() => SwapWindowsManifestLinks(
            tree,
            honestTarget,
            stop.Token,
            outside =>
            {
                if (outside)
                {
                    Interlocked.Increment(ref outsideSwaps);
                }
                else
                {
                    Interlocked.Increment(ref honestSwaps);
                }
            }));
        var acquired = 0;
        try
        {
            for (var index = 0; index < 2000; index++)
            {
                var result = PlatformInstalledManifestWindowsReader.Read(
                    tree.Snapshot(),
                    CancellationToken.None);
                if (result.Outcome == PlatformInstalledManifestOutcome.Acquired)
                {
                    acquired++;
                    Assert.Equal(honest, result.Bytes);
                    Assert.NotEqual(outside, result.Bytes.ToArray());
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
        Assert.True(Volatile.Read(ref honestSwaps) > 0);
        Assert.True(Volatile.Read(ref outsideSwaps) > 0);
    }

    [Fact]
    public void WindowsEmptyOrDuplicateDllInventoryFailsClosed()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        tree.WriteManifest(PlatformInstalledManifestBindingTests.ManifestBytes());

        var empty = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray<string>.Empty),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.AssemblyUnavailable, empty.Outcome);

        var duplicate = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(ImmutableArray.Create(tree.AssemblyPath, tree.AssemblyPath)),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.AssemblyMismatch, duplicate.Outcome);

        var overBound = PlatformInstalledManifestWindowsReader.Read(
            tree.Snapshot(Enumerable.Repeat(
                    tree.AssemblyPath,
                    PlatformInstalledManifestLimits.MaximumDllFileCount + 1)
                .ToImmutableArray()),
            CancellationToken.None);
        Assert.Equal(PlatformInstalledManifestOutcome.AssemblyMismatch, overBound.Outcome);
    }

    [Fact]
    public void WindowsPreCancelledReadThrowsWithoutPublishingAResult()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        using var tree = new WindowsReaderTree();
        tree.WriteManifest(PlatformInstalledManifestBindingTests.ManifestBytes());
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Assert.Throws<OperationCanceledException>(() =>
            PlatformInstalledManifestWindowsReader.Read(tree.Snapshot(), cancellation.Token));
    }

    [Fact]
    public async Task WindowsActiveOverlappedReadHonorsCancellationAndCompletesCleanup()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var pipeName = "jc-manifest-cancel-" + Guid.NewGuid().ToString("N");
        using var server = new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
        using var client = new NamedPipeClientStream(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);
        var clientConnect = client.ConnectAsync();
        await server.WaitForConnectionAsync();
        await clientConnect;

        using var borrowedHandle = new SafeFileHandle(
            server.SafePipeHandle.DangerousGetHandle(),
            ownsHandle: false);
        var buffer = Marshal.AllocHGlobal(1);
        try
        {
            using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
            var method = typeof(PlatformInstalledManifestWindowsReader).GetMethod(
                "ReadOverlappedChunk",
                BindingFlags.Static | BindingFlags.NonPublic)!;
            var wrapper = Assert.Throws<TargetInvocationException>(() => method.Invoke(
                null,
                new object[] { borrowedHandle, buffer, 1U, 0UL, cancellation.Token }));
            Assert.IsType<OperationCanceledException>(wrapper.InnerException);
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string[] Forbidden(string source) => ForbiddenTokens
        .Where(token => source.Contains(token, StringComparison.OrdinalIgnoreCase))
        .ToArray();

    private static void AssertOrdered(string source, params string[] values)
    {
        var previous = -1;
        foreach (var value in values)
        {
            var current = source.IndexOf(value, previous + 1, StringComparison.Ordinal);
            Assert.True(current > previous, $"Expected '{value}' after offset {previous}.");
            previous = current;
        }
    }

    private static PlatformInstalledPluginSnapshot Snapshot() =>
        PlatformInstalledPluginSnapshot.EstablishHostSnapshot(
            Guid.Parse("11111111-2222-3333-4444-555555555555"),
            "Example Provider",
            new Version(1, 2, 3, 4),
            PlatformInstalledPluginHostStatus.Active,
            "C:\\plugins\\example",
            ImmutableArray.Create("C:\\plugins\\example\\Example.Provider.dll"));

    private static bool TryCreateFileLink(string linkPath, string targetPath)
    {
        try
        {
            File.CreateSymbolicLink(linkPath, targetPath);
            return true;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or PlatformNotSupportedException)
        {
            return false;
        }
    }

    private static bool TryCreateDirectoryLink(string linkPath, string targetPath)
    {
        try
        {
            Directory.CreateSymbolicLink(linkPath, targetPath);
            return true;
        }
        catch (Exception exception) when (exception is IOException
            or UnauthorizedAccessException
            or PlatformNotSupportedException)
        {
            return false;
        }
    }

    private static void SwapWindowsManifestLinks(
        WindowsReaderTree tree,
        string honestTarget,
        CancellationToken cancellationToken,
        Action<bool> swapped)
    {
        var iteration = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            var target = iteration++ % 2 == 0 ? honestTarget : tree.OutsideManifest;
            var temporary = Path.Combine(tree.Root, ".swap-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.CreateSymbolicLink(temporary, target);
                File.Move(temporary, tree.ManifestPath, overwrite: true);
                swapped(!string.Equals(target, honestTarget, StringComparison.Ordinal));
            }
            catch (IOException)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
            }
            catch (UnauthorizedAccessException)
            {
                if (cancellationToken.IsCancellationRequested)
                {
                    return;
                }
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

    private static string Code(string file) => PlatformHostSeamTests.CodeOnly(File.ReadAllText(file));

    private static string SourceFile([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(sourceFile)!,
            "..",
            "..",
            "Jellyfin.Plugin.JellyfinCanopy",
            "Platform",
            ReaderFileName));

    private static string RepositoryRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", ".."));

    private sealed class WindowsReaderTree : IDisposable
    {
        private readonly string _top;

        internal WindowsReaderTree()
        {
            _top = Path.Combine(Path.GetTempPath(), "jc-win-reader-" + Guid.NewGuid().ToString("N"));
            Root = Path.Combine(_top, "plugin");
            var outside = Path.Combine(_top, "outside");
            Directory.CreateDirectory(Root);
            Directory.CreateDirectory(outside);
            ManifestPath = Path.Combine(Root, PlatformExtensionManifestParser.ManifestFileName);
            OutsideManifest = Path.Combine(outside, "manifest.json");
            AssemblyPath = Path.Combine(Root, "Example.Provider.dll");
            File.WriteAllBytes(AssemblyPath, new byte[] { 1, 2, 3 });
        }

        internal string Root { get; }

        internal string ManifestPath { get; }

        internal string OutsideManifest { get; }

        internal string AssemblyPath { get; }

        internal void WriteManifest(byte[] bytes) => File.WriteAllBytes(ManifestPath, bytes);

        internal PlatformInstalledPluginSnapshot Snapshot(ImmutableArray<string>? dllFiles = null) =>
            PlatformInstalledPluginSnapshot.EstablishHostSnapshot(
                Guid.Parse("11111111-2222-3333-4444-555555555555"),
                "Example Provider",
                new Version(1, 2, 3, 4),
                PlatformInstalledPluginHostStatus.Active,
                Root,
                dllFiles ?? ImmutableArray.Create(AssemblyPath));

        public void Dispose()
        {
            try
            {
                Directory.Delete(_top, recursive: true);
            }
            catch (IOException)
            {
                // Windows may briefly retain a just-cancelled overlapped handle.
            }
            catch (UnauthorizedAccessException)
            {
                // Cleanup is best effort for a disposable test tree only.
            }
        }
    }
}
