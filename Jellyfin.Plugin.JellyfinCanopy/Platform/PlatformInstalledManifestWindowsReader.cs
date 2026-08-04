using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Win32.SafeHandles;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Windows handle-verification owner for the fixed installed-provider manifest.
    /// Every containment decision is made from an open handle; lexical paths are
    /// defense in depth and never become post-open evidence.
    /// </summary>
    [ExcludeFromCodeCoverage]
    internal static class PlatformInstalledManifestWindowsReader
    {
        private const uint GenericRead = 0x80000000;
        private const uint FileListDirectory = 0x00000001;
        private const uint FileReadAttributes = 0x00000080;
        private const uint Synchronize = 0x00100000;
        private const uint ShareReadWriteDelete = 0x00000007;
        private const uint OpenExisting = 3;
        private const uint FileFlagOpenReparsePoint = 0x00200000;
        private const uint FileFlagBackupSemantics = 0x02000000;
        private const uint FileFlagSequentialScan = 0x08000000;
        private const uint FileFlagOverlapped = 0x40000000;

        private const uint FileTypeDisk = 0x0001;
        private const uint DriveFixed = 3;
        private const int ErrorFileNotFound = 2;
        private const int ErrorPathNotFound = 3;
        private const int ErrorHandleEof = 38;
        private const int ErrorIoPending = 997;
        private const int ErrorOperationAborted = 995;
        private const int MaximumFinalPathCharacters = 32768;
        private const int ReadTimeoutMilliseconds = 2000;

        /// <summary>
        /// Reads one fixed manifest on Windows or returns a closed, redaction-safe outcome.
        /// Cancellation is caller control and therefore propagates rather than becoming
        /// plugin health.
        /// </summary>
        internal static PlatformInstalledManifestReadResult Read(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(snapshot);
            cancellationToken.ThrowIfCancellationRequested();
            if (!OperatingSystem.IsWindows())
            {
                return Rejected(PlatformInstalledManifestOutcome.DescriptorUnverifiable);
            }

            try
            {
                return ReadWindows(snapshot, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception exception) when (exception is ArgumentException
                or IOException
                or UnauthorizedAccessException
                or NotSupportedException
                or OverflowException
                or DllNotFoundException
                or EntryPointNotFoundException
                or BadImageFormatException
                or MarshalDirectiveException
                or PlatformNotSupportedException)
            {
                return Rejected(PlatformInstalledManifestOutcome.AcquisitionFailed);
            }
        }

        private static PlatformInstalledManifestReadResult ReadWindows(
            PlatformInstalledPluginSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            if (!TryNormalizeReportedRoot(snapshot.ReportedRoot, out var lexicalRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot);
            }

            using var rootHandle = CreateFileW(
                lexicalRoot,
                FileListDirectory | FileReadAttributes | Synchronize,
                ShareReadWriteDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics,
                IntPtr.Zero);
            if (rootHandle.IsInvalid
                || !TryGetObjectState(rootHandle, requireDirectory: true, out var rootBefore)
                || !TryGetFinalPath(rootHandle, out var descriptorRoot)
                || !IsSupportedLocalRoot(descriptorRoot)
                || IsFilesystemRoot(descriptorRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.UnsafeOrUnverifiableRoot);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var fixedEntry = Path.Combine(descriptorRoot, PlatformExtensionManifestParser.ManifestFileName);
            using var manifestMetadataHandle = CreateFileW(
                fixedEntry,
                FileReadAttributes | Synchronize,
                ShareReadWriteDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOverlapped,
                IntPtr.Zero);
            if (manifestMetadataHandle.IsInvalid)
            {
                return Rejected(MapFixedEntryOpenFailure(fixedEntry));
            }

            if (!TryGetObjectState(manifestMetadataHandle, requireDirectory: false, out var manifestBefore))
            {
                return Rejected(PlatformInstalledManifestOutcome.NotRegularFile);
            }

            if (manifestBefore.Identity.VolumeSerialNumber != rootBefore.Identity.VolumeSerialNumber
                || !TryGetFinalPath(manifestMetadataHandle, out var manifestFinalPath))
            {
                return Rejected(PlatformInstalledManifestOutcome.DescriptorUnverifiable);
            }

            if (!IsStrictlyInside(manifestFinalPath, descriptorRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.UnsafeTarget);
            }

            if (manifestBefore.EndOfFile > PlatformExtensionManifestBounds.MaximumDocumentBytes)
            {
                return Rejected(PlatformInstalledManifestOutcome.DocumentTooLarge);
            }

            using var manifestReadHandle = ReOpenFile(
                manifestMetadataHandle,
                GenericRead | FileReadAttributes | Synchronize,
                ShareReadWriteDelete,
                FileFlagOverlapped | FileFlagSequentialScan);
            if (manifestReadHandle.IsInvalid
                || !TryGetObjectState(manifestReadHandle, requireDirectory: false, out var readBefore)
                || !manifestBefore.Identity.Equals(readBefore.Identity)
                || !TryGetFinalPath(manifestReadHandle, out var readFinalPath)
                || !string.Equals(manifestFinalPath, readFinalPath, StringComparison.OrdinalIgnoreCase))
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var read = ReadBoundedOverlapped(manifestReadHandle, cancellationToken);
            if (read.Outcome != PlatformInstalledManifestOutcome.Acquired)
            {
                return Rejected(read.Outcome);
            }

            if (!TryGetObjectState(manifestMetadataHandle, requireDirectory: false, out var manifestAfter)
                || !TryGetObjectState(manifestReadHandle, requireDirectory: false, out var readAfter)
                || !manifestBefore.StableEquals(manifestAfter)
                || !manifestBefore.StableEquals(readAfter)
                || manifestAfter.EndOfFile != read.Bytes.Length
                || !TryGetFinalPath(manifestReadHandle, out var readPathAfter)
                || !string.Equals(manifestFinalPath, readPathAfter, StringComparison.OrdinalIgnoreCase)
                || !FixedEntryStillNamesStableObject(fixedEntry, manifestBefore, manifestFinalPath)
                || !RootStillNamesObject(lexicalRoot, rootBefore.Identity, descriptorRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            cancellationToken.ThrowIfCancellationRequested();
            var assembly = VerifyAssembly(snapshot, descriptorRoot, rootBefore.Identity, cancellationToken);
            if (assembly.Outcome != PlatformInstalledManifestOutcome.Acquired)
            {
                return Rejected(assembly.Outcome);
            }

            if (!TryGetObjectState(manifestMetadataHandle, requireDirectory: false, out var finalManifestState)
                || !TryGetObjectState(manifestReadHandle, requireDirectory: false, out var finalReadState)
                || !manifestBefore.StableEquals(finalManifestState)
                || !manifestBefore.StableEquals(finalReadState)
                || finalManifestState.EndOfFile != read.Bytes.Length
                || !TryGetFinalPath(manifestMetadataHandle, out var finalMetadataPath)
                || !TryGetFinalPath(manifestReadHandle, out var finalReadPath)
                || !string.Equals(manifestFinalPath, finalMetadataPath, StringComparison.OrdinalIgnoreCase)
                || !string.Equals(manifestFinalPath, finalReadPath, StringComparison.OrdinalIgnoreCase)
                || !FixedEntryStillNamesStableObject(fixedEntry, manifestBefore, manifestFinalPath)
                || !RootStillNamesObject(lexicalRoot, rootBefore.Identity, descriptorRoot))
            {
                return Rejected(PlatformInstalledManifestOutcome.ReadChanged);
            }

            cancellationToken.ThrowIfCancellationRequested();
            return PlatformInstalledManifestReadResult.Acquired(read.Bytes, assembly.AssemblyIdentity);
        }

        private static AssemblyVerification VerifyAssembly(
            PlatformInstalledPluginSnapshot snapshot,
            string descriptorRoot,
            FileIdentity rootIdentity,
            CancellationToken cancellationToken)
        {
            if (snapshot.DllFiles.IsDefaultOrEmpty)
            {
                return new AssemblyVerification(PlatformInstalledManifestOutcome.AssemblyUnavailable, null);
            }

            if (snapshot.DllFiles.Length > PlatformInstalledManifestLimits.MaximumDllFileCount)
            {
                return new AssemblyVerification(PlatformInstalledManifestOutcome.AssemblyMismatch, null);
            }

            var dllHandles = new List<SafeFileHandle>(snapshot.DllFiles.Length);
            try
            {
                var verifiedDlls = new List<VerifiedDll>(snapshot.DllFiles.Length);
                var canonicalNames = new HashSet<string>(StringComparer.Ordinal);
                foreach (var reportedDll in snapshot.DllFiles)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (!TryGetRelativeReportedPath(
                            snapshot.ReportedRoot,
                            reportedDll,
                            out var dllRelativePath))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var fixedDllEntry = Path.Combine(descriptorRoot, dllRelativePath);
                    var dllHandle = CreateFileW(
                        fixedDllEntry,
                        FileReadAttributes | Synchronize,
                        ShareReadWriteDelete,
                        IntPtr.Zero,
                        OpenExisting,
                        FileFlagOverlapped,
                        IntPtr.Zero);
                    dllHandles.Add(dllHandle);
                    if (dllHandle.IsInvalid
                        || !TryGetObjectState(dllHandle, requireDirectory: false, out var dllState)
                        || dllState.Identity.VolumeSerialNumber != rootIdentity.VolumeSerialNumber
                        || !TryGetFinalPath(dllHandle, out var finalDllPath)
                        || !IsStrictlyInside(finalDllPath, descriptorRoot)
                        || !FixedEntryStillNamesStableObject(fixedDllEntry, dllState, finalDllPath))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var finalRelativePath = Path.GetRelativePath(descriptorRoot, finalDllPath);
                    if (Path.IsPathFullyQualified(finalRelativePath)
                        || finalRelativePath.Split('\\', '/').Any(part => part is "." or ".."))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    var canonicalName = CanonicalizeRelativeName(finalRelativePath);
                    if (!canonicalNames.Add(canonicalName))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }

                    verifiedDlls.Add(new VerifiedDll(
                        fixedDllEntry,
                        finalDllPath,
                        canonicalName,
                        dllState));
                }

                for (var index = 0; index < verifiedDlls.Count; index++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var verifiedDll = verifiedDlls[index];
                    if (!TryGetObjectState(
                            dllHandles[index],
                            requireDirectory: false,
                            out var retainedState)
                        || !verifiedDll.State.StableEquals(retainedState)
                        || !TryGetFinalPath(dllHandles[index], out var retainedPath)
                        || !string.Equals(
                            verifiedDll.FinalPath,
                            retainedPath,
                            StringComparison.OrdinalIgnoreCase)
                        || !FixedEntryStillNamesStableObject(
                            verifiedDll.FixedEntry,
                            verifiedDll.State,
                            verifiedDll.FinalPath))
                    {
                        return new AssemblyVerification(
                            PlatformInstalledManifestOutcome.AssemblyMismatch,
                            null);
                    }
                }

                cancellationToken.ThrowIfCancellationRequested();
                return new AssemblyVerification(
                    PlatformInstalledManifestOutcome.Acquired,
                    ComputeAssemblySetIdentity(verifiedDlls));
            }
            finally
            {
                foreach (var dllHandle in dllHandles)
                {
                    dllHandle.Dispose();
                }
            }
        }

        private static string CanonicalizeRelativeName(string relativePath) =>
            relativePath.Replace('/', '\\').ToUpperInvariant();

        private static string ComputeAssemblySetIdentity(List<VerifiedDll> verifiedDlls)
        {
            const string domain = "jellyfin-canopy:installed-assembly-set:v1";
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            AppendHashField(hash, Encoding.UTF8.GetBytes(domain));
            foreach (var dll in verifiedDlls.OrderBy(item => item.CanonicalRelativeName, StringComparer.Ordinal))
            {
                AppendHashField(hash, Encoding.UTF8.GetBytes(dll.CanonicalRelativeName));
                AppendHashUInt64(hash, dll.State.Identity.VolumeSerialNumber);
                AppendHashUInt64(hash, dll.State.Identity.Low);
                AppendHashUInt64(hash, dll.State.Identity.High);
            }

            return "dll-set-sha256:" + Convert.ToHexString(hash.GetHashAndReset());
        }

        private static void AppendHashField(IncrementalHash hash, byte[] value)
        {
            Span<byte> length = stackalloc byte[sizeof(int)];
            System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(length, value.Length);
            hash.AppendData(length);
            hash.AppendData(value);
        }

        private static void AppendHashUInt64(IncrementalHash hash, ulong value)
        {
            Span<byte> encoded = stackalloc byte[sizeof(ulong)];
            System.Buffers.Binary.BinaryPrimitives.WriteUInt64BigEndian(encoded, value);
            hash.AppendData(encoded);
        }

        private static BoundedReadResult ReadBoundedOverlapped(
            SafeFileHandle handle,
            CancellationToken cancellationToken)
        {
            var capacity = PlatformExtensionManifestBounds.MaximumDocumentBytes + 1;
            var buffer = new byte[capacity];
            var pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
            try
            {
                var total = 0;
                while (total < capacity)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    var chunk = ReadOverlappedChunk(
                        handle,
                        IntPtr.Add(pinned.AddrOfPinnedObject(), total),
                        checked((uint)(capacity - total)),
                        checked((ulong)total),
                        cancellationToken);
                    if (chunk.Outcome != PlatformInstalledManifestOutcome.Acquired)
                    {
                        return new BoundedReadResult(chunk.Outcome, []);
                    }

                    if (chunk.BytesRead == 0)
                    {
                        break;
                    }

                    total += checked((int)chunk.BytesRead);
                }

                if (total > PlatformExtensionManifestBounds.MaximumDocumentBytes)
                {
                    return new BoundedReadResult(PlatformInstalledManifestOutcome.DocumentTooLarge, []);
                }

                return new BoundedReadResult(
                    PlatformInstalledManifestOutcome.Acquired,
                    buffer.AsSpan(0, total).ToArray());
            }
            finally
            {
                pinned.Free();
            }
        }

        private static OverlappedReadResult ReadOverlappedChunk(
            SafeFileHandle handle,
            IntPtr buffer,
            uint count,
            ulong offset,
            CancellationToken cancellationToken)
        {
            using var completion = new EventWaitHandle(false, EventResetMode.ManualReset);
            var native = new NativeOverlappedData
            {
                Offset = unchecked((uint)offset),
                OffsetHigh = unchecked((uint)(offset >> 32)),
                EventHandle = completion.SafeWaitHandle.DangerousGetHandle(),
            };
            var nativePointer = Marshal.AllocHGlobal(Marshal.SizeOf<NativeOverlappedData>());
            try
            {
                Marshal.StructureToPtr(native, nativePointer, fDeleteOld: false);
                var started = ReadFile(handle, buffer, count, IntPtr.Zero, nativePointer);
                if (!started)
                {
                    var error = Marshal.GetLastPInvokeError();
                    if (error == ErrorHandleEof)
                    {
                        return new OverlappedReadResult(PlatformInstalledManifestOutcome.Acquired, 0);
                    }

                    if (error != ErrorIoPending)
                    {
                        return new OverlappedReadResult(PlatformInstalledManifestOutcome.ReadFailed, 0);
                    }

                    var wait = WaitHandle.WaitAny(
                        new[] { completion, cancellationToken.WaitHandle },
                        ReadTimeoutMilliseconds);
                    if (wait != 0)
                    {
                        _ = CancelIoEx(handle, nativePointer);
                        _ = GetOverlappedResult(handle, nativePointer, out _, wait: true);
                        if (cancellationToken.IsCancellationRequested)
                        {
                            throw new OperationCanceledException(cancellationToken);
                        }

                        return new OverlappedReadResult(PlatformInstalledManifestOutcome.OpenTimedOut, 0);
                    }
                }

                if (!GetOverlappedResult(handle, nativePointer, out var transferred, wait: false))
                {
                    var error = Marshal.GetLastPInvokeError();
                    return error is ErrorHandleEof
                        ? new OverlappedReadResult(PlatformInstalledManifestOutcome.Acquired, 0)
                        : error is ErrorOperationAborted && cancellationToken.IsCancellationRequested
                            ? throw new OperationCanceledException(cancellationToken)
                            : new OverlappedReadResult(PlatformInstalledManifestOutcome.ReadFailed, 0);
                }

                cancellationToken.ThrowIfCancellationRequested();
                return new OverlappedReadResult(PlatformInstalledManifestOutcome.Acquired, transferred);
            }
            finally
            {
                Marshal.FreeHGlobal(nativePointer);
            }
        }

        private static bool FixedEntryStillNamesStableObject(
            string path,
            ObjectState expectedState,
            string expectedFinalPath)
        {
            using var current = CreateFileW(
                path,
                FileReadAttributes | Synchronize,
                ShareReadWriteDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOverlapped,
                IntPtr.Zero);
            return !current.IsInvalid
                && TryGetObjectState(current, requireDirectory: false, out var state)
                && expectedState.StableEquals(state)
                && TryGetFinalPath(current, out var finalPath)
                && string.Equals(expectedFinalPath, finalPath, StringComparison.OrdinalIgnoreCase);
        }

        private static bool RootStillNamesObject(
            string path,
            FileIdentity expectedIdentity,
            string expectedFinalPath)
        {
            using var current = CreateFileW(
                path,
                FileListDirectory | FileReadAttributes | Synchronize,
                ShareReadWriteDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagBackupSemantics,
                IntPtr.Zero);
            return !current.IsInvalid
                && TryGetObjectState(current, requireDirectory: true, out var state)
                && expectedIdentity.Equals(state.Identity)
                && TryGetFinalPath(current, out var finalPath)
                && string.Equals(expectedFinalPath, finalPath, StringComparison.OrdinalIgnoreCase);
        }

        private static PlatformInstalledManifestOutcome MapFixedEntryOpenFailure(string path)
        {
            var error = Marshal.GetLastPInvokeError();
            if (error is not (ErrorFileNotFound or ErrorPathNotFound))
            {
                return PlatformInstalledManifestOutcome.ReadFailed;
            }

            using var link = CreateFileW(
                path,
                FileReadAttributes | Synchronize,
                ShareReadWriteDelete,
                IntPtr.Zero,
                OpenExisting,
                FileFlagOpenReparsePoint | FileFlagBackupSemantics,
                IntPtr.Zero);
            return link.IsInvalid
                ? PlatformInstalledManifestOutcome.ManifestAbsent
                : PlatformInstalledManifestOutcome.UnsafeTarget;
        }

        private static bool TryGetObjectState(
            SafeFileHandle handle,
            bool requireDirectory,
            out ObjectState state)
        {
            state = default;
            if (handle.IsInvalid
                || GetFileType(handle) != FileTypeDisk
                || !GetFileInformationByHandleExIdentity(
                    handle,
                    FileInfoByHandleClass.FileIdInfo,
                    out var identity,
                    (uint)Marshal.SizeOf<NativeFileIdInfo>())
                || !GetFileInformationByHandleExBasic(
                    handle,
                    FileInfoByHandleClass.FileBasicInfo,
                    out var basic,
                    (uint)Marshal.SizeOf<NativeFileBasicInfo>())
                || !GetFileInformationByHandleExStandard(
                    handle,
                    FileInfoByHandleClass.FileStandardInfo,
                    out var standard,
                    (uint)Marshal.SizeOf<NativeFileStandardInfo>())
                || standard.DeletePending
                || standard.Directory != requireDirectory)
            {
                return false;
            }

            state = new ObjectState(
                new FileIdentity(identity.VolumeSerialNumber, identity.FileId.Low, identity.FileId.High),
                basic.CreationTime,
                basic.LastWriteTime,
                basic.ChangeTime,
                basic.FileAttributes,
                standard.AllocationSize,
                standard.EndOfFile,
                standard.NumberOfLinks);
            return true;
        }

        private static bool TryGetFinalPath(SafeFileHandle handle, out string path)
        {
            path = string.Empty;
            var buffer = new char[MaximumFinalPathCharacters];
            var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Length, 0);
            if (length == 0 || length >= buffer.Length)
            {
                return false;
            }

            var nativePath = new string(buffer, 0, checked((int)length));
            if (nativePath.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var normalized = nativePath.StartsWith("\\\\?\\", StringComparison.Ordinal)
                ? nativePath[4..]
                : nativePath;
            return TryGetComparableFullPath(normalized, out path);
        }

        private static bool TryNormalizeReportedRoot(string? path, out string normalized)
        {
            normalized = string.Empty;
            if (string.IsNullOrWhiteSpace(path) || HasUnsafeLexicalShape(path))
            {
                return false;
            }

            var separators = path.Replace('/', '\\');
            if (!Path.IsPathFullyQualified(separators)
                || separators.Split('\\', StringSplitOptions.RemoveEmptyEntries).Any(part => part == "..")
                || !TryGetComparableFullPath(separators, out normalized))
            {
                return false;
            }

            return !IsFilesystemRoot(normalized);
        }

        private static bool TryGetRelativeReportedPath(
            string reportedRoot,
            string candidate,
            out string relativePath)
        {
            relativePath = string.Empty;
            if (!TryNormalizeReportedRoot(reportedRoot, out var root)
                || string.IsNullOrWhiteSpace(candidate)
                || HasUnsafeLexicalShape(candidate)
                || !TryGetComparableFullPath(candidate.Replace('/', '\\'), out var fullCandidate)
                || !IsStrictlyInside(fullCandidate, root))
            {
                return false;
            }

            relativePath = Path.GetRelativePath(root, fullCandidate);
            return !Path.IsPathFullyQualified(relativePath)
                && !relativePath.Split('\\', '/').Any(part => part == "..");
        }

        private static bool TryGetComparableFullPath(string path, out string fullPath)
        {
            fullPath = string.Empty;
            try
            {
                fullPath = Path.TrimEndingDirectorySeparator(Path.GetFullPath(path));
                return fullPath.Length > 0 && !IsUncOrDevicePath(fullPath);
            }
            catch (Exception exception) when (exception is ArgumentException
                or IOException
                or NotSupportedException
                or PathTooLongException)
            {
                return false;
            }
        }

        private static bool IsUncOrDevicePath(string path) =>
            path.StartsWith("\\\\", StringComparison.Ordinal)
            || path.StartsWith("\\??\\", StringComparison.Ordinal)
            || path.StartsWith("\\Device\\", StringComparison.OrdinalIgnoreCase);

        private static bool HasUnsafeLexicalShape(string path)
        {
            if (path.Contains('\0', StringComparison.Ordinal) || IsUncOrDevicePath(path))
            {
                return true;
            }

            var segments = path.Split(new[] { '\\', '/' }, StringSplitOptions.None);
            if (segments.Any(segment => segment is "." or ".."))
            {
                return true;
            }

            var firstColon = path.IndexOf(':', StringComparison.Ordinal);
            return firstColon != 1
                || !char.IsAsciiLetter(path[0])
                || path.Length < 3
                || path[2] is not ('\\' or '/')
                || path.IndexOf(':', firstColon + 1) >= 0;
        }

        private static bool IsFilesystemRoot(string path)
        {
            var root = Path.GetPathRoot(path);
            return !string.IsNullOrEmpty(root)
                && string.Equals(
                    Path.TrimEndingDirectorySeparator(path),
                    Path.TrimEndingDirectorySeparator(root),
                    StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsSupportedLocalRoot(string path)
        {
            var root = Path.GetPathRoot(path);
            return !string.IsNullOrEmpty(root) && GetDriveTypeW(root) == DriveFixed;
        }

        private static bool IsStrictlyInside(string candidate, string root)
        {
            var canonicalRoot = Path.TrimEndingDirectorySeparator(root);
            if (string.Equals(candidate, canonicalRoot, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var prefix = canonicalRoot.EndsWith(Path.DirectorySeparatorChar)
                || canonicalRoot.EndsWith(Path.AltDirectorySeparatorChar)
                    ? canonicalRoot
                    : canonicalRoot + Path.DirectorySeparatorChar;
            return candidate.StartsWith(prefix, StringComparison.OrdinalIgnoreCase);
        }

        private static PlatformInstalledManifestReadResult Rejected(
            PlatformInstalledManifestOutcome outcome) =>
            PlatformInstalledManifestReadResult.Rejected(outcome);

        private readonly record struct FileIdentity(ulong VolumeSerialNumber, ulong Low, ulong High);

        private readonly record struct ObjectState(
            FileIdentity Identity,
            long CreationTime,
            long LastWriteTime,
            long ChangeTime,
            uint FileAttributes,
            long AllocationSize,
            long EndOfFile,
            uint NumberOfLinks)
        {
            internal bool StableEquals(ObjectState other) =>
                Identity.Equals(other.Identity)
                && CreationTime == other.CreationTime
                && LastWriteTime == other.LastWriteTime
                && ChangeTime == other.ChangeTime
                && FileAttributes == other.FileAttributes
                && AllocationSize == other.AllocationSize
                && EndOfFile == other.EndOfFile
                && NumberOfLinks == other.NumberOfLinks;
        }

        private readonly record struct BoundedReadResult(
            PlatformInstalledManifestOutcome Outcome,
            byte[] Bytes);

        private readonly record struct OverlappedReadResult(
            PlatformInstalledManifestOutcome Outcome,
            uint BytesRead);

        private readonly record struct AssemblyVerification(
            PlatformInstalledManifestOutcome Outcome,
            string? AssemblyIdentity);

        private readonly record struct VerifiedDll(
            string FixedEntry,
            string FinalPath,
            string CanonicalRelativeName,
            ObjectState State);

        private enum FileInfoByHandleClass
        {
            FileBasicInfo = 0,
            FileStandardInfo = 1,
            FileIdInfo = 18,
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileId128
        {
            internal ulong Low;
            internal ulong High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileIdInfo
        {
            internal ulong VolumeSerialNumber;
            internal NativeFileId128 FileId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileBasicInfo
        {
            internal long CreationTime;
            internal long LastAccessTime;
            internal long LastWriteTime;
            internal long ChangeTime;
            internal uint FileAttributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeFileStandardInfo
        {
            internal long AllocationSize;
            internal long EndOfFile;
            internal uint NumberOfLinks;

            [MarshalAs(UnmanagedType.U1)]
            internal bool DeletePending;

            [MarshalAs(UnmanagedType.U1)]
            internal bool Directory;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeOverlappedData
        {
            internal IntPtr Internal;
            internal IntPtr InternalHigh;
            internal uint Offset;
            internal uint OffsetHigh;
            internal IntPtr EventHandle;
        }

#pragma warning disable SYSLIB1054 // Win32 handle APIs require SafeFileHandle and explicit overlapped lifetime control.
        [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode,
            ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", EntryPoint = "ReOpenFile", ExactSpelling = true, SetLastError = true)]
        private static extern SafeFileHandle ReOpenFile(
            SafeFileHandle originalFile,
            uint desiredAccess,
            uint shareMode,
            uint flagsAndAttributes);

        [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode,
            ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(
            SafeFileHandle file,
            char[] filePath,
            uint filePathSize,
            uint flags);

        [DllImport("kernel32.dll", EntryPoint = "GetFileType", ExactSpelling = true, SetLastError = true)]
        private static extern uint GetFileType(SafeFileHandle file);

        [DllImport("kernel32.dll", EntryPoint = "GetDriveTypeW", CharSet = CharSet.Unicode,
            ExactSpelling = true, SetLastError = true)]
        private static extern uint GetDriveTypeW(string rootPathName);

        [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx",
            ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleExIdentity(
            SafeFileHandle file,
            FileInfoByHandleClass informationClass,
            out NativeFileIdInfo information,
            uint bufferSize);

        [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx",
            ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleExBasic(
            SafeFileHandle file,
            FileInfoByHandleClass informationClass,
            out NativeFileBasicInfo information,
            uint bufferSize);

        [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx",
            ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleExStandard(
            SafeFileHandle file,
            FileInfoByHandleClass informationClass,
            out NativeFileStandardInfo information,
            uint bufferSize);

        [DllImport("kernel32.dll", EntryPoint = "ReadFile", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ReadFile(
            SafeFileHandle file,
            IntPtr buffer,
            uint bytesToRead,
            IntPtr bytesRead,
            IntPtr overlapped);

        [DllImport("kernel32.dll", EntryPoint = "CancelIoEx", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CancelIoEx(SafeFileHandle file, IntPtr overlapped);

        [DllImport("kernel32.dll", EntryPoint = "GetOverlappedResult", ExactSpelling = true, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetOverlappedResult(
            SafeFileHandle file,
            IntPtr overlapped,
            out uint bytesTransferred,
            [MarshalAs(UnmanagedType.Bool)] bool wait);
#pragma warning restore SYSLIB1054
    }
}
