using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Crash-safe file writes: serialize to a unique temp sibling, fsync its contents to
    /// disk, then atomically rename over the destination via File.Move(overwrite:true), and
    /// fsync the parent directory so the rename itself survives a power loss. A crash,
    /// disk-full, or power loss can lose the temp file but can NEVER leave the real file
    /// truncated/half-written OR renamed-but-empty. This is the ONLY sanctioned way to
    /// overwrite a config / user / shared file in the plugin — see the AtomicFileWriteGuardTests
    /// architecture test. Callers that need mutual exclusion (read-modify-write) still hold
    /// their own lock; atomicity and locking are orthogonal.
    /// </summary>
    internal static class AtomicFile
    {
        // UTF-8 no-BOM, matching File.WriteAllText's default encoding so existing
        // on-disk bytes are byte-identical (keeps UserFileFormatGoldenTests green).
        private static readonly UTF8Encoding Utf8NoBom = new(false);

        /// <summary>
        /// Test-only seam: set to true when the most recent durable write ON THE CURRENT THREAD
        /// fsync'd the temp file's contents (FileStream.Flush(flushToDisk: true)) before the rename.
        /// [ThreadStatic] so a concurrent write on another thread can't race the flag. Lets the
        /// durability test prove the content flush ran without simulating power loss.
        /// </summary>
        [ThreadStatic]
        internal static bool LastDurableWriteFlushedContents;

        public static void WriteAllText(string path, string contents)
            => WriteBytesDurable(path, Utf8NoBom.GetBytes(contents));

        public static void WriteAllBytes(string path, byte[] contents)
            => WriteBytesDurable(path, contents);

        // For streamed uploads: write the body into a temp sibling, then commit on full success.
        public static async System.Threading.Tasks.Task WriteViaAsync(
            string path, Func<Stream, System.Threading.Tasks.Task> writeBody)
        {
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    await writeBody(stream).ConfigureAwait(false);
                    await stream.FlushAsync().ConfigureAwait(false);
                    stream.Flush(flushToDisk: true); // fsync contents to disk BEFORE the rename
                }

                File.Move(temp, path, overwrite: true);
                TryFsyncDirectory(Path.GetDirectoryName(path)); // persist the rename itself
            }
            catch
            {
                TryDelete(temp);
                throw;
            }
        }

        // The single durable-write core: temp sibling -> fsync contents -> atomic rename ->
        // fsync parent dir. Flushing the CONTENTS before the rename is the load-bearing part:
        // File.WriteAllText/WriteAllBytes only flush to the OS page cache, so a power loss right
        // after the rename could leave the destination present but empty/partial.
        private static void WriteBytesDurable(string path, byte[] contents)
        {
            LastDurableWriteFlushedContents = false;
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    stream.Write(contents, 0, contents.Length);
                    stream.Flush(flushToDisk: true); // fsync contents to disk BEFORE the rename
                    LastDurableWriteFlushedContents = true;
                }

                File.Move(temp, path, overwrite: true);
                TryFsyncDirectory(Path.GetDirectoryName(path)); // persist the rename itself
            }
            catch
            {
                TryDelete(temp);
                throw;
            }
        }

        // Best-effort fsync of the directory that contains a just-renamed file. On POSIX the
        // rename metadata is only durable once the containing directory is fsync'd; there is no
        // managed API for this (FileStream refuses to open a directory), so we open the dir
        // read-only and fsync its descriptor. Any failure — or a platform that doesn't support
        // it (Windows) — is swallowed: the contents fsync above already prevents torn file data.
        private static void TryFsyncDirectory(string? dir)
        {
            if (string.IsNullOrEmpty(dir)) return;
            if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS() && !OperatingSystem.IsFreeBSD()) return;

            try
            {
                var fd = Open(dir, ORdonly);
                if (fd < 0) return;
                try
                {
                    Fsync(fd);
                }
                finally
                {
                    Close(fd);
                }
            }
            catch
            {
                /* best-effort: dir-fsync is unsupported or failed; contents are already durable */
            }
        }

        private static void TryDelete(string temp)
        {
            try
            {
                if (File.Exists(temp))
                {
                    File.Delete(temp);
                }
            }
            catch
            {
                /* best-effort cleanup */
            }
        }

        // POSIX O_RDONLY (0 on Linux/macOS/BSD). Opening the directory read-only is enough to
        // obtain a descriptor we can fsync. DllImport (not LibraryImport) is deliberate: these are
        // only ever called on Unix behind the OperatingSystem guard, and DllImport avoids the
        // source-generated unsafe marshalling that LibraryImport would emit (the project does not
        // enable AllowUnsafeBlocks). On Unix the runtime marshals the path as UTF-8.
        private const int ORdonly = 0;

#pragma warning disable SYSLIB1054 // scoped: keep DllImport to avoid pulling in unsafe marshalling
        [DllImport("libc", EntryPoint = "open", SetLastError = true)]
        private static extern int Open(string path, int flags);

        [DllImport("libc", EntryPoint = "fsync", SetLastError = true)]
        private static extern int Fsync(int fd);

        [DllImport("libc", EntryPoint = "close", SetLastError = true)]
        private static extern int Close(int fd);
#pragma warning restore SYSLIB1054
    }
}
