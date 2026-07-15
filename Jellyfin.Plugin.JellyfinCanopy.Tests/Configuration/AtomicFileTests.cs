using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Direct unit tests of the crash-safe write helper. These assert the two
    /// properties every caller relies on:
    ///   1. UTF-8 no-BOM output (keeps UserFileFormatGoldenTests byte-identical), and
    ///   2. a failed/partial write NEVER truncates the previously-good destination
    ///      (the W4-LEAK-7 truncate-then-copy defect a naive FileStream(Create) has).
    /// Every routed JSON/file caller (MaintenanceModeService, index.html,
    /// BrandingController, UserConfigurationStore, TagCacheService, AssetCacheService)
    /// delegates to this helper, so proving the helper + the write-guard proving they
    /// USE it is the complete durability net.
    /// </summary>
    public class AtomicFileTests : IDisposable
    {
        private readonly string _dir;

        public AtomicFileTests()
        {
            _dir = Path.Combine(Path.GetTempPath(), "jc-atomicfile-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            try { Directory.Delete(_dir, recursive: true); } catch { /* best effort */ }
        }

        private string Dest(string name) => Path.Combine(_dir, name);

        private int TempSiblingCount(string dest)
            => Directory.GetFiles(_dir, Path.GetFileName(dest) + ".tmp.*").Length;

        [Fact]
        public void WriteAllText_ReplacesContentByteExact_NoBom()
        {
            var dest = Dest("settings.json");

            AtomicFile.WriteAllText(dest, "A");
            AtomicFile.WriteAllText(dest, "BB");

            Assert.Equal("BB", File.ReadAllText(dest));

            // Byte-exact: first byte is 'B' (0x42), NOT the UTF-8 BOM (EF BB BF).
            // A BOM here would shift every persisted-JSON golden.
            var bytes = File.ReadAllBytes(dest);
            Assert.Equal(new byte[] { 0x42, 0x42 }, bytes);
            Assert.NotEqual(new byte[] { 0xEF, 0xBB, 0xBF }, bytes.Take(3).ToArray());
        }

        [Fact]
        public void WriteAllText_FlushesContentsToDiskBeforeRename()
        {
            var dest = Dest("durable.json");

            AtomicFile.LastDurableWriteFlushedContents = false;
            AtomicFile.WriteAllText(dest, "payload");

            // The load-bearing crash-durability guarantee: the temp file's CONTENTS must be
            // fsync'd (FileStream.Flush(flushToDisk: true)) before the atomic rename. A naive
            // File.WriteAllText only flushes to the OS page cache, so a power loss right after
            // the rename could leave a present-but-empty destination. (RED against the old
            // File.WriteAllText path: the flag is never set.)
            Assert.True(AtomicFile.LastDurableWriteFlushedContents);
            Assert.Equal("payload", File.ReadAllText(dest));
        }

        [Fact]
        public void WriteAllBytes_FlushesContentsToDiskBeforeRename()
        {
            var dest = Dest("durable.bin");

            AtomicFile.LastDurableWriteFlushedContents = false;
            AtomicFile.WriteAllBytes(dest, new byte[] { 1, 2, 3 });

            Assert.True(AtomicFile.LastDurableWriteFlushedContents);
            Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(dest));
        }

        [Fact]
        public void WriteAllText_NonAsciiRoundTrips_NoBom()
        {
            var dest = Dest("unicode.json");
            const string content = "Amélie — 映画 ☕";

            AtomicFile.WriteAllText(dest, content);

            Assert.Equal(content, File.ReadAllText(dest));
            var bytes = File.ReadAllBytes(dest);
            // Must equal UTF-8 no-BOM encoding of the same string.
            Assert.Equal(new UTF8Encoding(false).GetBytes(content), bytes);
        }

        [Fact]
        public void WriteAllBytes_RoundTrips_AndLeavesNoTemp()
        {
            var dest = Dest("blob.bin");
            var payload = new byte[] { 1, 2, 3, 250, 251, 252 };

            AtomicFile.WriteAllBytes(dest, payload);

            Assert.Equal(payload, File.ReadAllBytes(dest));
            Assert.Equal(0, TempSiblingCount(dest));
        }

        [Fact]
        public void WriteAllText_NoTempLeftOnSuccess()
        {
            var dest = Dest("clean.json");
            AtomicFile.WriteAllText(dest, "hello");
            Assert.Equal(0, TempSiblingCount(dest));
        }

        [Fact]
        public async Task WriteViaAsync_LeavesPriorFileIntactWhenBodyThrows()
        {
            // The load-bearing durability guarantee: a partial/failed streamed write
            // must not destroy the previously-good file. A naive
            // new FileStream(dest, FileMode.Create) truncates dest to zero BEFORE the
            // copy begins — this test fails against that pattern and passes against
            // the temp-sibling+rename helper.
            var dest = Dest("branding.png");
            await File.WriteAllTextAsync(dest, "GOOD");

            await Assert.ThrowsAsync<IOException>(async () =>
                await AtomicFile.WriteViaAsync(dest, async stream =>
                {
                    var partial = Encoding.UTF8.GetBytes("BAD-PARTIAL");
                    await stream.WriteAsync(partial);
                    throw new IOException("boom");
                }));

            // Prior file is byte-for-byte intact, and no temp sibling leaked.
            Assert.Equal("GOOD", await File.ReadAllTextAsync(dest));
            Assert.Equal(0, TempSiblingCount(dest));
        }

        [Fact]
        public async Task WriteViaAsync_CommitsBodyOnSuccess()
        {
            var dest = Dest("upload.bin");
            var payload = new byte[] { 9, 8, 7, 6 };

            await AtomicFile.WriteViaAsync(dest, async stream => await stream.WriteAsync(payload));

            Assert.Equal(payload, await File.ReadAllBytesAsync(dest));
            Assert.Equal(0, TempSiblingCount(dest));
        }
    }
}
