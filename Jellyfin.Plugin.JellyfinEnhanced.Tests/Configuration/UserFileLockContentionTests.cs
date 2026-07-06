using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.Tests.TestDoubles;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Configuration
{
    /// <summary>
    /// Manager-level proof of the shared per-user-file lock contract behind MB-1.
    /// The full-replace bookmark save (<c>UserSettingsController.SaveUserBookmark</c>)
    /// used to skip <c>GetUserFileLock</c> while the sibling add/remove endpoints mutate
    /// the SAME <c>bookmark.json</c> under <c>RmwUserConfiguration</c>'s lock — so a
    /// full-save could interleave inside an add's read-modify-write and drop the
    /// just-committed bookmark (lost update).
    ///
    /// This test drives the two paths against the same user file: one group via the
    /// locked <see cref="UserConfigurationManager.RmwUserConfiguration{T}"/> primitive,
    /// the other via the SAME lock+strict-read+save shape the fixed controller now uses.
    /// Because both share <c>GetUserFileLock(userId, "bookmark.json")</c>, no update is
    /// lost. (Confirmed RED by dropping the lock from the second group: adds are clobbered
    /// and the count assertion fails.)
    /// </summary>
    public class UserFileLockContentionTests : IDisposable
    {
        private const string UserId = "3f2504e04f8941d39a0c0305e82c3301";

        private readonly string _baseDir;
        private readonly UserConfigurationManager _manager;

        public UserFileLockContentionTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "je-userfilelock-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
        }

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        [Fact]
        public async Task RmwAddsAndLockedFullSaves_ShareTheLock_LoseNoUpdate()
        {
            const int rmwWriters = 4;
            const int savWriters = 4;
            const int perWriter = 25;

            var rmwTasks = Enumerable.Range(0, rmwWriters).Select(w => Task.Run(() =>
            {
                for (int i = 0; i < perWriter; i++)
                {
                    var id = $"rmw_{w}_{i}";
                    _manager.RmwUserConfiguration<UserBookmark>(UserId, "bookmark.json", cfg =>
                    {
                        cfg.Bookmarks[id] = new BookmarkItem { ItemId = id, MediaType = "movie" };
                        return 1;
                    });
                }
            }));

            // Mirrors the fixed SaveUserBookmark: hold the SAME per-user file lock across the
            // strict-read + save so it can't interleave inside an RMW and clobber a committed add.
            var saveTasks = Enumerable.Range(0, savWriters).Select(w => Task.Run(() =>
            {
                for (int i = 0; i < perWriter; i++)
                {
                    var id = $"sav_{w}_{i}";
                    lock (_manager.GetUserFileLock(UserId, "bookmark.json"))
                    {
                        var cfg = _manager.GetUserConfigurationStrict<UserBookmark>(UserId, "bookmark.json");
                        cfg.Bookmarks[id] = new BookmarkItem { ItemId = id, MediaType = "tv" };
                        _manager.SaveUserConfiguration(UserId, "bookmark.json", cfg);
                    }
                }
            }));

            await Task.WhenAll(rmwTasks.Concat(saveTasks));

            var final = _manager.GetUserConfiguration<UserBookmark>(UserId, "bookmark.json");
            var expected = (rmwWriters * perWriter) + (savWriters * perWriter);
            Assert.Equal(expected, final.Bookmarks.Count);

            for (int w = 0; w < rmwWriters; w++)
            {
                for (int i = 0; i < perWriter; i++)
                {
                    Assert.True(final.Bookmarks.ContainsKey($"rmw_{w}_{i}"));
                }
            }

            for (int w = 0; w < savWriters; w++)
            {
                for (int i = 0; i < perWriter; i++)
                {
                    Assert.True(final.Bookmarks.ContainsKey($"sav_{w}_{i}"));
                }
            }
        }
    }
}
