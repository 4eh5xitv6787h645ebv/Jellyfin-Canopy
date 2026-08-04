using System;
using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Win32.SafeHandles;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Reads only the fixed installed-provider manifest through Linux descriptors.
    /// Unsupported operating systems fail closed; there is deliberately no
    /// validate-then-open or background-thread fallback.
    /// </summary>
    internal sealed class PlatformInstalledManifestFileReader : IPlatformInstalledManifestReader
    {
        private const int OpenReadOnly = 0;
        private const int OpenNonBlocking = 0x800;
        private const int OpenDirectory = 0x10000;
        private const int OpenCloseOnExec = 0x80000;
        private const int OpenPath = 0x200000;

        private const int AtEmptyPath = 0x1000;
        private const uint StatxType = 0x0001;
        private const uint StatxModificationTime = 0x0040;
        private const uint StatxChangeTime = 0x0080;
        private const uint StatxInode = 0x0100;
        private const uint StatxSize = 0x0200;
        private const uint StatxMountId = 0x1000;
        private const uint RequiredStatxMask = StatxType
            | StatxModificationTime
            | StatxChangeTime
            | StatxInode
            | StatxSize
            | StatxMountId;

        private const ushort FileTypeMask = 0xF000;
        private const ushort DirectoryType = 0x4000;
        private const ushort RegularFileType = 0x8000;

        private const int ErrorInterrupted = 4;
        private const int ErrorNoEntry = 2;
        private const int ErrorNotDirectory = 20;
        private const int ErrorLoop = 40;

        private const int MaximumDescriptorPathBytes = 4096;
        private const string DeletedDescriptorSuffix = " (deleted)";
        private const string AssemblySetIdentityDomain =
            "jellyfin-canopy-installed-plugin-assembly-set-v1";

        private static readonly UTF8Encoding StrictUtf8 = new(false, true);
        private static readonly HashSet<long> SupportedLocalFileSystemTypes =
        [
            0x0000EF53, // ext2/3/4
            0x01021994, // tmpfs
            0x2FC12FC1, // zfs
            0x3153464A, // jfs
            0x3434, // nilfs
            0x52654973, // reiserfs
            0x5346544E, // ntfs
            0x58465342, // xfs
            0x794C7630, // overlayfs
            0x9123683E, // btrfs
            0xCAFE4A11, // bcachefs
            0xF2F52010, // f2fs
        ];

        private readonly Action? _afterManifestMetadataOpen;
        private readonly Action? _afterManifestRead;
        private readonly Action? _afterAssemblyMetadataOpen;

        /// <summary>Initializes the production reader without test race hooks.</summary>
        public PlatformInstalledManifestFileReader()
        {
        }

        /// <summary>Initializes a reader with deterministic race hooks for descriptor tests.</summary>
        internal PlatformInstalledManifestFileReader(
            Action? afterManifestMetadataOpen,
            Action? afterManifestRead,
            Action? afterAssemblyMetadataOpen = null)
        {
            _afterManifestMetadataOpen = afterManifestMetadataOpen;
            _afterManifestRead = afterManifestRead;
            _afterAssemblyMetadataOpen = afterAssemblyMetadataOpen;
        }

        /// <inheritdoc />
        public ValueTask<PlatformInstalledManifestReadResult> ReadAsync(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(snapshot);
            cancellationToken.ThrowIfCancellationRequested();

            if (OperatingSystem.IsWindows())
            {
                return ValueTask.FromResult(
                    PlatformInstalledManifestWindowsReader.Read(snapshot, cancellationToken));
            }

            if (!OperatingSystem.IsLinux())
            {
                return ValueTask.FromResult(Rejected(
                    PlatformInstalledManifestOutcome.DescriptorUnverifiable));
            }

            try
            {
                return ValueTask.FromResult(ReadLinux(snapshot, cancellationToken));
            }
            catch (Exception exception) when (exception is DllNotFoundException
                or EntryPointNotFoundException
                or BadImageFormatException
                or MarshalDirectiveException
                or PlatformNotSupportedException)
            {
                return ValueTask.FromResult(Rejected(
                    PlatformInstalledManifestOutcome.DescriptorUnverifiable));
            }
        }

        private PlatformInstalledManifestReadResult ReadLinux(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            if (!TryCanonicalizeReportedRoot(snapshot.ReportedRoot, out var reportedRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var rootDescriptor = Open(
                reportedRoot,
                OpenReadOnly | OpenNonBlocking | OpenDirectory | OpenCloseOnExec);
            if (rootDescriptor < 0)
            {
                return Rejected(PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot);
            }

            using var rootHandle = new SafeUnixDescriptor(rootDescriptor);
            if (!TryFStat(rootDescriptor, out var rootBefore)
                || (rootBefore.Mode & FileTypeMask) != DirectoryType
                || !IsSupportedLocalFileSystem(rootDescriptor)
                || !TryDescribeDescriptor(rootDescriptor, out var descriptorRoot)
                || IsFilesystemRoot(descriptorRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot);
            }

            var manifestOpen = OpenFixedManifest(rootDescriptor);
            if (manifestOpen.MetadataDescriptor < 0 || manifestOpen.ContentDescriptor < 0)
            {
                return Rejected(manifestOpen.Outcome);
            }

            using var manifestMetadataHandle = new SafeUnixDescriptor(manifestOpen.MetadataDescriptor);
            using var manifestContentHandle = new SafeUnixDescriptor(manifestOpen.ContentDescriptor);
            if (!TryVerifyRegularDescriptor(
                    manifestOpen.MetadataDescriptor,
                    descriptorRoot,
                    rootBefore,
                    out var manifestMetadataBefore,
                    out var manifestDescriptorPath,
                    out var manifestFailure))
            {
                return Rejected(manifestFailure);
            }

            if (!TryVerifyRegularDescriptor(
                    manifestOpen.ContentDescriptor,
                    descriptorRoot,
                    rootBefore,
                    out var manifestBefore,
                    out var manifestContentPath,
                    out manifestFailure))
            {
                return Rejected(manifestFailure);
            }

            if (!SameObject(manifestMetadataBefore, manifestBefore)
                || !string.Equals(
                    manifestDescriptorPath,
                    manifestContentPath,
                    StringComparison.Ordinal))
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            if (manifestBefore.Size > PlatformExtensionManifestBounds.MaximumDocumentBytes)
            {
                return Rejected(PlatformInstalledManifestOutcome.DocumentTooLarge);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var read = ReadBounded(manifestOpen.ContentDescriptor, cancellationToken);
            if (read.Outcome != PlatformInstalledManifestOutcome.Acquired)
            {
                return Rejected(read.Outcome);
            }

            _afterManifestRead?.Invoke();

            if (!TryFStat(manifestOpen.ContentDescriptor, out var manifestAfter)
                || !TryFStat(manifestOpen.MetadataDescriptor, out var manifestMetadataAfter)
                || !TryFStat(rootDescriptor, out var rootAfter)
                || !TryDescribeDescriptor(manifestOpen.ContentDescriptor, out var manifestPathAfter)
                || !TryDescribeDescriptor(manifestOpen.MetadataDescriptor, out var manifestMetadataPathAfter)
                || !TryDescribeDescriptor(rootDescriptor, out var rootPathAfter))
            {
                return Rejected(PlatformInstalledManifestOutcome.DescriptorUnverifiable);
            }

            if (!rootBefore.Equals(rootAfter)
                || !manifestBefore.Equals(manifestAfter)
                || !SameObject(manifestMetadataBefore, manifestMetadataAfter)
                || !string.Equals(descriptorRoot, rootPathAfter, StringComparison.Ordinal)
                || !string.Equals(manifestDescriptorPath, manifestPathAfter, StringComparison.Ordinal)
                || !string.Equals(manifestDescriptorPath, manifestMetadataPathAfter, StringComparison.Ordinal)
                || manifestAfter.Size != (ulong)read.Bytes.Length)
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            if (!TryRevalidateNamedObjects(
                    reportedRoot,
                    rootDescriptor,
                    descriptorRoot,
                    rootBefore,
                    manifestMetadataBefore,
                    manifestDescriptorPath))
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var assembly = VerifyAssemblySet(
                snapshot,
                descriptorRoot,
                rootBefore,
                _afterAssemblyMetadataOpen,
                cancellationToken);
            if (assembly.Outcome != PlatformInstalledManifestOutcome.Acquired)
            {
                return Rejected(assembly.Outcome);
            }

            if (!TryRevalidateNamedObjects(
                    reportedRoot,
                    rootDescriptor,
                    descriptorRoot,
                    rootBefore,
                    manifestMetadataBefore,
                    manifestDescriptorPath))
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            cancellationToken.ThrowIfCancellationRequested();
            return PlatformInstalledManifestReadResult.Acquired(
                read.Bytes,
                assembly.AssemblyIdentity);
        }

        private DescriptorOpenResult OpenFixedManifest(int rootDescriptor)
        {
            var metadataDescriptor = OpenAt(
                rootDescriptor,
                PlatformExtensionManifestParser.ManifestFileName,
                OpenPath | OpenCloseOnExec);
            if (metadataDescriptor < 0)
            {
                return MapManifestOpenFailure(rootDescriptor, manifestExistedBeforeOpen: false);
            }

            var contentDescriptor = -1;
            try
            {
                if (!TryFStat(metadataDescriptor, out var typeState))
                {
                    return new DescriptorOpenResult(
                        -1,
                        -1,
                        PlatformInstalledManifestOutcome.DescriptorUnverifiable);
                }

                if ((typeState.Mode & FileTypeMask) != RegularFileType)
                {
                    return new DescriptorOpenResult(
                        -1,
                        -1,
                        PlatformInstalledManifestOutcome.NotRegularFile);
                }

                _afterManifestMetadataOpen?.Invoke();

                if (!TryGetDescriptorPath(metadataDescriptor, out var metadataDescriptorPath))
                {
                    return new DescriptorOpenResult(
                        -1,
                        -1,
                        PlatformInstalledManifestOutcome.DescriptorUnverifiable);
                }

                contentDescriptor = Open(
                    metadataDescriptorPath,
                    OpenReadOnly | OpenNonBlocking | OpenCloseOnExec);
                if (contentDescriptor < 0)
                {
                    return new DescriptorOpenResult(
                        -1,
                        -1,
                        PlatformInstalledManifestOutcome.DescriptorUnverifiable);
                }

                var result = new DescriptorOpenResult(
                    metadataDescriptor,
                    contentDescriptor,
                    PlatformInstalledManifestOutcome.Acquired);
                metadataDescriptor = -1;
                contentDescriptor = -1;
                return result;
            }
            finally
            {
                if (contentDescriptor >= 0)
                {
                    Close(contentDescriptor);
                }

                if (metadataDescriptor >= 0)
                {
                    Close(metadataDescriptor);
                }
            }
        }

        private static DescriptorOpenResult MapManifestOpenFailure(
            int rootDescriptor,
            bool manifestExistedBeforeOpen)
        {
            var error = Marshal.GetLastPInvokeError();
            if (error is ErrorNoEntry or ErrorNotDirectory)
            {
                return new DescriptorOpenResult(
                    -1,
                    -1,
                    IsBrokenLink(rootDescriptor, PlatformExtensionManifestParser.ManifestFileName)
                        ? PlatformInstalledManifestOutcome.UnsafeTarget
                        : manifestExistedBeforeOpen
                            ? PlatformInstalledManifestOutcome.ReadChanged
                            : PlatformInstalledManifestOutcome.ManifestAbsent);
            }

            return new DescriptorOpenResult(
                -1,
                -1,
                error == ErrorLoop
                    ? PlatformInstalledManifestOutcome.UnsafeTarget
                    : PlatformInstalledManifestOutcome.ReadFailed);
        }

        private static AssemblyVerification VerifyAssemblySet(
            PlatformInstalledPluginSnapshot snapshot,
            string descriptorRoot,
            DescriptorState rootState,
            Action? afterAssemblyMetadataOpen,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (snapshot.DllFiles.IsDefaultOrEmpty)
            {
                return new AssemblyVerification(
                    PlatformInstalledManifestOutcome.AssemblyUnavailable,
                    null);
            }

            if (snapshot.DllFiles.Length > PlatformInstalledManifestLimits.MaximumDllFileCount)
            {
                return new AssemblyVerification(
                    PlatformInstalledManifestOutcome.AssemblyMismatch,
                    null);
            }

            if (!TryGetHostFullPath(snapshot.ReportedRoot, out var reportedRoot))
            {
                return new AssemblyVerification(
                    PlatformInstalledManifestOutcome.AssemblyMismatch,
                    null);
            }

            var handles = new List<SafeUnixDescriptor>(snapshot.DllFiles.Length);
            var observations = new List<DllDescriptorObservation>(snapshot.DllFiles.Length);
            try
            {
                foreach (var reportedDll in snapshot.DllFiles)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!TryGetHostFullPath(reportedDll, out var dllPath)
                        || !IsInsideEitherRoot(dllPath, reportedRoot, descriptorRoot))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var dllDescriptor = Open(dllPath, OpenPath | OpenCloseOnExec);
                    if (dllDescriptor < 0)
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var dllHandle = new SafeUnixDescriptor(dllDescriptor);
                    handles.Add(dllHandle);
                    if (!TryVerifyRegularDescriptor(
                            dllDescriptor,
                            descriptorRoot,
                            rootState,
                            out var dllState,
                            out var dllDescriptorPath,
                            out _))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var relativeName = Path.GetRelativePath(
                            descriptorRoot,
                            dllDescriptorPath)
                        .Replace(Path.DirectorySeparatorChar, '/');
                    if (string.IsNullOrWhiteSpace(relativeName)
                        || Path.IsPathFullyQualified(relativeName)
                        || relativeName.Split('/').Any(segment => segment is "." or ".."))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    observations.Add(new DllDescriptorObservation(
                        dllPath,
                        dllDescriptor,
                        relativeName,
                        dllDescriptorPath,
                        dllState));
                }

                cancellationToken.ThrowIfCancellationRequested();
                afterAssemblyMetadataOpen?.Invoke();

                foreach (var observation in observations)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!TryVerifyRegularDescriptor(
                            observation.Descriptor,
                            descriptorRoot,
                            rootState,
                            out var retainedState,
                            out var retainedPath,
                            out _)
                        || !observation.State.Equals(retainedState)
                        || !string.Equals(
                            observation.DescriptorPath,
                            retainedPath,
                            StringComparison.Ordinal))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var namedDescriptor = Open(
                        observation.ReportedPath,
                        OpenPath | OpenCloseOnExec);
                    if (namedDescriptor < 0)
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    using var namedHandle = new SafeUnixDescriptor(namedDescriptor);
                    if (!TryVerifyRegularDescriptor(
                            namedDescriptor,
                            descriptorRoot,
                            rootState,
                            out var namedState,
                            out var namedPath,
                            out _)
                        || !observation.State.Equals(namedState)
                        || !string.Equals(
                            observation.DescriptorPath,
                            namedPath,
                            StringComparison.Ordinal))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }
                }

                var ordered = observations
                    .OrderBy(observation => observation.RelativeName, StringComparer.Ordinal)
                    .ToList();
                if (ordered
                    .GroupBy(observation => observation.RelativeName, StringComparer.Ordinal)
                    .Any(group => group.Count() != 1))
                {
                    return new AssemblyVerification(
                        PlatformInstalledManifestOutcome.AssemblyMismatch,
                        null);
                }

                using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
                hash.AppendData(Encoding.UTF8.GetBytes(AssemblySetIdentityDomain));
                hash.AppendData([0]);
                AppendUnsigned(hash, checked((ulong)ordered.Count));
                foreach (var observation in ordered)
                {
                    var nameBytes = Encoding.UTF8.GetBytes(observation.RelativeName);
                    AppendUnsigned(hash, checked((ulong)nameBytes.Length));
                    hash.AppendData(nameBytes);
                    AppendDescriptorState(hash, observation.State);
                }

                return new AssemblyVerification(
                    PlatformInstalledManifestOutcome.Acquired,
                    "sha256:" + Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant());
            }
            finally
            {
                foreach (var handle in handles)
                {
                    handle.Dispose();
                }
            }
        }

        private static void AppendDescriptorState(
            IncrementalHash hash,
            DescriptorState state)
        {
            AppendUnsigned(hash, state.MountId);
            AppendUnsigned(hash, state.DeviceMajor);
            AppendUnsigned(hash, state.DeviceMinor);
            AppendUnsigned(hash, state.Inode);
            AppendUnsigned(hash, state.Size);
            AppendSigned(hash, state.ModificationSeconds);
            AppendUnsigned(hash, state.ModificationNanoseconds);
            AppendSigned(hash, state.ChangeSeconds);
            AppendUnsigned(hash, state.ChangeNanoseconds);
        }

        private static void AppendUnsigned(IncrementalHash hash, ulong value)
        {
            Span<byte> encoded = stackalloc byte[sizeof(ulong)];
            BinaryPrimitives.WriteUInt64LittleEndian(encoded, value);
            hash.AppendData(encoded);
        }

        private static void AppendSigned(IncrementalHash hash, long value)
        {
            Span<byte> encoded = stackalloc byte[sizeof(long)];
            BinaryPrimitives.WriteInt64LittleEndian(encoded, value);
            hash.AppendData(encoded);
        }

        private static bool TryRevalidateNamedObjects(
            string reportedRoot,
            int rootDescriptor,
            string descriptorRoot,
            DescriptorState rootState,
            DescriptorState manifestState,
            string manifestDescriptorPath)
        {
            var namedRootDescriptor = Open(
                reportedRoot,
                OpenPath | OpenDirectory | OpenCloseOnExec);
            if (namedRootDescriptor < 0)
            {
                return false;
            }

            using var namedRootHandle = new SafeUnixDescriptor(namedRootDescriptor);
            if (!TryFStat(namedRootDescriptor, out var namedRootState)
                || (namedRootState.Mode & FileTypeMask) != DirectoryType
                || !rootState.Equals(namedRootState)
                || !TryDescribeDescriptor(namedRootDescriptor, out var namedRootPath)
                || !string.Equals(descriptorRoot, namedRootPath, StringComparison.Ordinal))
            {
                return false;
            }

            var namedManifestDescriptor = OpenAt(
                rootDescriptor,
                PlatformExtensionManifestParser.ManifestFileName,
                OpenPath | OpenCloseOnExec);
            if (namedManifestDescriptor < 0)
            {
                return false;
            }

            using var namedManifestHandle = new SafeUnixDescriptor(namedManifestDescriptor);
            return TryVerifyRegularDescriptor(
                    namedManifestDescriptor,
                    descriptorRoot,
                    rootState,
                    out var namedManifestState,
                    out var namedManifestPath,
                    out _)
                && manifestState.Equals(namedManifestState)
                && string.Equals(
                    manifestDescriptorPath,
                    namedManifestPath,
                    StringComparison.Ordinal);
        }

        private static bool TryVerifyRegularDescriptor(
            int descriptor,
            string descriptorRoot,
            DescriptorState rootState,
            out DescriptorState state,
            out string descriptorPath,
            out PlatformInstalledManifestOutcome failure)
        {
            state = default;
            descriptorPath = string.Empty;
            failure = PlatformInstalledManifestOutcome.DescriptorUnverifiable;
            if (!TryFStat(descriptor, out state))
            {
                return false;
            }

            if ((state.Mode & FileTypeMask) != RegularFileType)
            {
                failure = PlatformInstalledManifestOutcome.NotRegularFile;
                return false;
            }

            if (state.DeviceMajor != rootState.DeviceMajor
                || state.DeviceMinor != rootState.DeviceMinor
                || state.MountId != rootState.MountId)
            {
                failure = PlatformInstalledManifestOutcome.UnsafeTarget;
                return false;
            }

            if (!TryDescribeDescriptor(descriptor, out descriptorPath))
            {
                return false;
            }

            if (!IsStrictlyInside(descriptorPath, descriptorRoot))
            {
                failure = PlatformInstalledManifestOutcome.UnsafeTarget;
                return false;
            }

            return true;
        }

        private static BoundedReadResult ReadBounded(
            int descriptor,
            CancellationToken cancellationToken)
        {
            var capacity = PlatformExtensionManifestBounds.MaximumDocumentBytes + 1;
            var nativeBuffer = Marshal.AllocHGlobal(capacity);
            try
            {
                var total = 0;
                while (total < capacity)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var count = Read(
                        descriptor,
                        IntPtr.Add(nativeBuffer, total),
                        (nuint)(capacity - total));
                    if (count == 0)
                    {
                        break;
                    }

                    if (count < 0)
                    {
                        if (Marshal.GetLastPInvokeError() == ErrorInterrupted)
                        {
                            continue;
                        }

                        return new BoundedReadResult(
                            PlatformInstalledManifestOutcome.ReadFailed,
                            []);
                    }

                    total += checked((int)count);
                }

                if (total > PlatformExtensionManifestBounds.MaximumDocumentBytes)
                {
                    return new BoundedReadResult(
                        PlatformInstalledManifestOutcome.DocumentTooLarge,
                        []);
                }

                var bytes = new byte[total];
                if (total > 0)
                {
                    Marshal.Copy(nativeBuffer, bytes, 0, total);
                }

                return new BoundedReadResult(
                    PlatformInstalledManifestOutcome.Acquired,
                    bytes);
            }
            finally
            {
                Marshal.FreeHGlobal(nativeBuffer);
            }
        }

        private static bool TryCanonicalizeReportedRoot(string? root, out string canonical)
        {
            canonical = string.Empty;
            if (string.IsNullOrWhiteSpace(root)
                || !TryGetHostFullPath(root, out canonical))
            {
                return false;
            }

            return !IsFilesystemRoot(canonical);
        }

        private static bool TryGetFullPath(string path, out string fullPath)
        {
            fullPath = string.Empty;
            try
            {
                fullPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
                return fullPath.Length > 0;
            }
            catch (Exception exception) when (exception is ArgumentException
                or IOException
                or NotSupportedException
                or PathTooLongException)
            {
                return false;
            }
        }

        private static bool TryGetHostFullPath(string path, out string fullPath)
        {
            fullPath = string.Empty;
            if (string.IsNullOrWhiteSpace(path) || path.Contains('\0', StringComparison.Ordinal))
            {
                return false;
            }

            var normalized = path
                .Replace('\\', Path.DirectorySeparatorChar)
                .Replace('/', Path.DirectorySeparatorChar);
            var segments = normalized.Split(
                Path.DirectorySeparatorChar,
                StringSplitOptions.RemoveEmptyEntries);
            if (!Path.IsPathFullyQualified(normalized)
                || normalized.StartsWith(
                    new string(Path.DirectorySeparatorChar, 2),
                    StringComparison.Ordinal)
                || normalized.StartsWith(
                    Path.DirectorySeparatorChar + "??" + Path.DirectorySeparatorChar,
                    StringComparison.Ordinal)
                || normalized.AsSpan(1).Contains(
                    new string(Path.DirectorySeparatorChar, 2),
                    StringComparison.Ordinal)
                || segments.Any(segment => segment is "." or ".."))
            {
                return false;
            }

            return TryGetFullPath(normalized, out fullPath);
        }

        private static bool IsFilesystemRoot(string path)
        {
            var trimmed = Path.TrimEndingDirectorySeparator(path);
            var root = Path.GetPathRoot(path);
            return !string.IsNullOrEmpty(root)
                && string.Equals(trimmed, Path.TrimEndingDirectorySeparator(root), StringComparison.Ordinal);
        }

        private static bool IsStrictlyInside(string candidate, string root)
        {
            var canonicalRoot = Path.TrimEndingDirectorySeparator(root);
            if (string.Equals(candidate, canonicalRoot, StringComparison.Ordinal))
            {
                return false;
            }

            var prefix = canonicalRoot.EndsWith(Path.DirectorySeparatorChar)
                ? canonicalRoot
                : canonicalRoot + Path.DirectorySeparatorChar;
            return candidate.StartsWith(prefix, StringComparison.Ordinal);
        }

        private static bool IsInsideEitherRoot(
            string candidate,
            string reportedRoot,
            string descriptorRoot) =>
            IsStrictlyInside(candidate, reportedRoot)
            || IsStrictlyInside(candidate, descriptorRoot);

        private static bool SameObject(DescriptorState left, DescriptorState right) =>
            left.Inode == right.Inode
            && left.DeviceMajor == right.DeviceMajor
            && left.DeviceMinor == right.DeviceMinor
            && left.MountId == right.MountId;

        private static bool TryGetDescriptorPath(int descriptor, out string descriptorPath)
        {
            descriptorPath = string.Empty;
            if (descriptor < 0)
            {
                return false;
            }

            descriptorPath = "/proc/self/fd/" + descriptor.ToString(
                System.Globalization.CultureInfo.InvariantCulture);
            return true;
        }

        private static bool TryDescribeDescriptor(int descriptor, out string path)
        {
            path = string.Empty;
            var rented = ArrayPool<byte>.Shared.Rent(MaximumDescriptorPathBytes + 1);
            try
            {
                if (!TryGetDescriptorPath(descriptor, out var descriptorPath))
                {
                    return false;
                }

                var count = ReadLink(descriptorPath, rented, (nuint)MaximumDescriptorPathBytes);
                if (count <= 0 || count >= MaximumDescriptorPathBytes)
                {
                    return false;
                }

                string described;
                try
                {
                    described = StrictUtf8.GetString(rented, 0, checked((int)count));
                }
                catch (DecoderFallbackException)
                {
                    return false;
                }

                if (!Path.IsPathFullyQualified(described)
                    || described.EndsWith(DeletedDescriptorSuffix, StringComparison.Ordinal)
                    || !TryGetFullPath(described, out path))
                {
                    path = string.Empty;
                    return false;
                }

                return true;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(rented);
            }
        }

        private static bool TryFStat(int descriptor, out DescriptorState state)
        {
            state = default;
            if (Statx(descriptor, string.Empty, AtEmptyPath, RequiredStatxMask, out var native) != 0
                || (native.Mask & RequiredStatxMask) != RequiredStatxMask)
            {
                return false;
            }

            state = new DescriptorState(
                native.Mode,
                native.Inode,
                native.Size,
                native.DeviceMajor,
                native.DeviceMinor,
                native.MountId,
                native.ModificationSeconds,
                native.ModificationNanoseconds,
                native.ChangeSeconds,
                native.ChangeNanoseconds);
            return true;
        }

        private static bool IsSupportedLocalFileSystem(int descriptor) =>
            FStatFs(descriptor, out var native) == 0
            && SupportedLocalFileSystemTypes.Contains(native.Type);

        private static bool IsBrokenLink(int rootDescriptor, string name)
        {
            var buffer = ArrayPool<byte>.Shared.Rent(MaximumDescriptorPathBytes);
            try
            {
                return ReadLinkAt(
                    rootDescriptor,
                    name,
                    buffer,
                    (nuint)MaximumDescriptorPathBytes) >= 0;
            }
            finally
            {
                ArrayPool<byte>.Shared.Return(buffer);
            }
        }

        private static PlatformInstalledManifestReadResult Rejected(
            PlatformInstalledManifestOutcome outcome) =>
            PlatformInstalledManifestReadResult.Rejected(outcome);

        private readonly record struct DescriptorOpenResult(
            int MetadataDescriptor,
            int ContentDescriptor,
            PlatformInstalledManifestOutcome Outcome);

        private readonly record struct BoundedReadResult(
            PlatformInstalledManifestOutcome Outcome,
            byte[] Bytes);

        private readonly record struct AssemblyVerification(
            PlatformInstalledManifestOutcome Outcome,
            string? AssemblyIdentity);

        private readonly record struct DllDescriptorObservation(
            string ReportedPath,
            int Descriptor,
            string RelativeName,
            string DescriptorPath,
            DescriptorState State);

        private readonly record struct DescriptorState(
            ushort Mode,
            ulong Inode,
            ulong Size,
            uint DeviceMajor,
            uint DeviceMinor,
            ulong MountId,
            long ModificationSeconds,
            uint ModificationNanoseconds,
            long ChangeSeconds,
            uint ChangeNanoseconds);

        [StructLayout(LayoutKind.Explicit, Size = 256)]
        private struct NativeStatx
        {
            [FieldOffset(0)]
            internal uint Mask;

            [FieldOffset(28)]
            internal ushort Mode;

            [FieldOffset(32)]
            internal ulong Inode;

            [FieldOffset(40)]
            internal ulong Size;

            [FieldOffset(96)]
            internal long ChangeSeconds;

            [FieldOffset(104)]
            internal uint ChangeNanoseconds;

            [FieldOffset(112)]
            internal long ModificationSeconds;

            [FieldOffset(120)]
            internal uint ModificationNanoseconds;

            [FieldOffset(136)]
            internal uint DeviceMajor;

            [FieldOffset(140)]
            internal uint DeviceMinor;

            [FieldOffset(144)]
            internal ulong MountId;
        }

        [StructLayout(LayoutKind.Explicit, Size = 120)]
        private struct NativeStatFs
        {
            [FieldOffset(0)]
            internal long Type;
        }

        private sealed class SafeUnixDescriptor : SafeHandleZeroOrMinusOneIsInvalid
        {
            internal SafeUnixDescriptor(int descriptor)
                : base(true)
            {
                SetHandle((IntPtr)descriptor);
            }

            protected override bool ReleaseHandle() =>
                PlatformInstalledManifestFileReader.Close(handle.ToInt32()) == 0;
        }

#pragma warning disable SYSLIB1054 // libc descriptor calls are guarded to Linux and require no generated marshalling.
        [DllImport("libc", EntryPoint = "open", SetLastError = true)]
        private static extern int Open(string path, int flags);

        [DllImport("libc", EntryPoint = "openat", SetLastError = true)]
        private static extern int OpenAt(int directoryDescriptor, string path, int flags);

        [DllImport("libc", EntryPoint = "read", SetLastError = true)]
        private static extern nint Read(int descriptor, IntPtr buffer, nuint count);

        [DllImport("libc", EntryPoint = "readlink", SetLastError = true)]
        private static extern nint ReadLink(string path, byte[] buffer, nuint count);

        [DllImport("libc", EntryPoint = "readlinkat", SetLastError = true)]
        private static extern nint ReadLinkAt(
            int directoryDescriptor,
            string path,
            byte[] buffer,
            nuint count);

        [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
        private static extern int Statx(
            int directoryDescriptor,
            string path,
            int flags,
            uint mask,
            out NativeStatx statx);

        [DllImport("libc", EntryPoint = "fstatfs", SetLastError = true)]
        private static extern int FStatFs(int descriptor, out NativeStatFs statfs);

        [DllImport("libc", EntryPoint = "close", SetLastError = true)]
        private static extern int Close(int descriptor);
#pragma warning restore SYSLIB1054
    }
}
