using System;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.JellyfinEnhanced.Configuration
{
    /// <summary>
    /// Crash-safe file writes: serialize to a unique temp sibling, then atomically
    /// rename over the destination via File.Move(overwrite:true). A crash, disk-full,
    /// or power loss can lose the temp file but can NEVER leave the real file
    /// truncated/half-written. This is the ONLY sanctioned way to overwrite a
    /// config / user / shared file in the plugin — see the AtomicFileWriteGuardTests
    /// architecture test. Callers that need mutual exclusion (read-modify-write) still
    /// hold their own lock; atomicity and locking are orthogonal.
    /// </summary>
    internal static class AtomicFile
    {
        // UTF-8 no-BOM, matching File.WriteAllText's default encoding so existing
        // on-disk bytes are byte-identical (keeps UserFileFormatGoldenTests green).
        private static readonly UTF8Encoding Utf8NoBom = new(false);

        public static void WriteAllText(string path, string contents)
        {
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllText(temp, contents, Utf8NoBom);
                File.Move(temp, path, overwrite: true);
            }
            catch
            {
                TryDelete(temp);
                throw;
            }
        }

        public static void WriteAllBytes(string path, byte[] contents)
        {
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                File.WriteAllBytes(temp, contents);
                File.Move(temp, path, overwrite: true);
            }
            catch
            {
                TryDelete(temp);
                throw;
            }
        }

        // For streamed uploads: write the body into a temp sibling, then commit on full success.
        public static async System.Threading.Tasks.Task WriteViaAsync(
            string path, Func<Stream, System.Threading.Tasks.Task> writeBody)
        {
            var temp = path + ".tmp." + Guid.NewGuid().ToString("N");
            try
            {
                using (var stream = new FileStream(temp, FileMode.Create, FileAccess.Write))
                {
                    await writeBody(stream).ConfigureAwait(false);
                }

                File.Move(temp, path, overwrite: true);
            }
            catch
            {
                TryDelete(temp);
                throw;
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
    }
}
