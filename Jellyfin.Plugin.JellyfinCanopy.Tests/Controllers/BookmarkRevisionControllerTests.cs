using System.Diagnostics;
using System.Security.Claims;
using System.Text.Json;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    /// <summary>
    /// Controller-level proofs for the bookmark revision contract. These tests
    /// deliberately submit caller-owned stale snapshots/operations; merely
    /// taking the same file lock is not sufficient to pass them.
    /// </summary>
    public sealed class BookmarkRevisionControllerTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly UserConfigurationManager _manager;
        private readonly User _user;
        private readonly CountingLibraryManager _libraryManager;
        private readonly ITestOutputHelper _output;

        public BookmarkRevisionControllerTests(ITestOutputHelper output)
        {
            _output = output;
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-bookmark-revision-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
            _user = new User("bookmark-user", "Provider", "PasswordProvider");
            _libraryManager = new CountingLibraryManager();
        }

        private string UserId => _user.Id.ToString("N");

        private string BookmarkPath => Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            UserId,
            "bookmark.json");

        private string DatabasePath => Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            "bookmarks.db");

        private UserConfigurationManager NewManager()
            => new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);

        public void Dispose()
        {
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        private UserSettingsController Controller()
        {
            var provider = new FakePluginConfigProvider(new PluginConfiguration());
            var controller = new UserSettingsController(
                new RecordingHttpClientFactory(new HttpClientHandler()),
                NullLogger<UserSettingsController>.Instance,
                new StubUserManager(_user),
                new SeerrCache(provider),
                provider,
                _manager,
                _libraryManager);
            controller.ControllerContext = new ControllerContext
            {
                HttpContext = new DefaultHttpContext
                {
                    User = new ClaimsPrincipal(new ClaimsIdentity(
                        new[] { new Claim("Jellyfin-UserId", _user.Id.ToString()) },
                        "TestAuth"))
                }
            };
            return controller;
        }

        private static BookmarkItem Bookmark(string itemId, string label = "")
            => new BookmarkItem
            {
                ItemId = itemId,
                MediaType = "movie",
                Name = itemId,
                Timestamp = 10,
                Label = label,
                CreatedAt = "2026-01-01T00:00:00.000Z",
                UpdatedAt = "2026-01-01T00:00:00.000Z"
            };

        private void Seed(params (string Id, BookmarkItem Bookmark)[] entries)
            => _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 0,
                Bookmarks = entries.ToDictionary(entry => entry.Id, entry => entry.Bookmark, StringComparer.Ordinal)
            });

        private UserBookmark State()
            => _manager.GetBookmarks(UserId);

        private string[] WaitForDatabaseBackups(int minimum = 1)
        {
            var directory = Path.GetDirectoryName(DatabasePath)!;
            string[] backups = Array.Empty<string>();
            Assert.True(SpinWait.SpinUntil(() =>
            {
                backups = Directory.GetFiles(directory, "bookmarks.db.backup-*")
                    .Where(path => !Path.GetFileName(path).Contains(".tmp", StringComparison.Ordinal))
                    .ToArray();
                return backups.Length >= minimum
                    && backups.All(path => DateTime.UtcNow - File.GetLastWriteTimeUtc(path) > TimeSpan.FromMilliseconds(250));
            }, TimeSpan.FromSeconds(10)), "Timed out waiting for the deferred bookmark database backup.");
            return backups;
        }

        private void ReplacePrimaryBytes(byte[] bytes)
        {
            File.Delete(DatabasePath + "-wal");
            File.Delete(DatabasePath + "-shm");
            File.WriteAllBytes(DatabasePath, bytes);
        }

        private object BookmarkStoreInstance()
            => typeof(UserConfigurationManager)
                .GetField("_bookmarks", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .GetValue(_manager)!;

        private void QuarantineBookmarkDatabaseGroup()
        {
            var store = BookmarkStoreInstance();
            store.GetType()
                .GetMethod("MoveCorruptDatabaseGroup", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .Invoke(store, null);
        }

        private void MakeBookmarkBackupDue()
        {
            var store = BookmarkStoreInstance();
            lock (BookmarkBackupLock(store))
            {
                store.GetType()
                    .GetField("_lastBackupUtc", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                    .SetValue(store, DateTime.MinValue);
            }
        }

        private long BookmarkBackupGeneration()
        {
            var store = BookmarkStoreInstance();
            lock (BookmarkBackupLock(store))
            {
                return (long)store.GetType()
                    .GetField("_backupRequestGeneration", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                    .GetValue(store)!;
            }
        }

        private Task? BookmarkBackupWorker()
        {
            var store = BookmarkStoreInstance();
            lock (BookmarkBackupLock(store))
            {
                return (Task?)store.GetType()
                .GetField("_backupWorker", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .GetValue(store);
            }
        }

        private static object BookmarkBackupLock(object store)
            => store.GetType()
                .GetField("_backupLock", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .GetValue(store)!;

        private void WaitForBookmarkBackupWorkerIdle()
            => Assert.True(
                SpinWait.SpinUntil(() => BookmarkBackupWorker() == null, TimeSpan.FromSeconds(10)),
                "Timed out waiting for the deferred bookmark backup worker to become idle.");

        private static UserSettingsController.BookmarkOperationPayload Add(string id, string itemId)
            => new UserSettingsController.BookmarkOperationPayload
            {
                Type = "add",
                BookmarkId = id,
                Bookmark = Bookmark(itemId)
            };

        private static UserSettingsController.BookmarkOperationPayload Delete(string id)
            => new UserSettingsController.BookmarkOperationPayload { Type = "delete", BookmarkId = id };

        private static UserSettingsController.BookmarkOperationPayload Move(string sourceId, string targetId, BookmarkItem bookmark)
            => new UserSettingsController.BookmarkOperationPayload
            {
                Type = "move",
                SourceBookmarkId = sourceId,
                BookmarkId = targetId,
                Bookmark = bookmark
            };

        private static UserSettingsController.BookmarkOperationPayload Offset(
            string id,
            double timestamp,
            string updatedAt = "2026-02-01T00:00:00.000Z")
            => new UserSettingsController.BookmarkOperationPayload
            {
                Type = "offset",
                BookmarkId = id,
                Timestamp = timestamp,
                UpdatedAt = updatedAt
            };

        [Fact]
        public void DedicatedAdd_PersistsVersionedIdentityFields()
        {
            Seed();
            var result = Controller().AddUserBookmark(UserId, new UserSettingsController.AddBookmarkPayload
            {
                Revision = 0,
                BookmarkId = "episode",
                ItemId = "episode-item",
                IdentityVersion = 1,
                ItemType = "episode",
                TmdbId = "episode-tmdb",
                SeriesTmdbId = "series-tmdb",
                MediaType = "tv",
                SeasonNumber = 0,
                EpisodeNumber = 2,
                EpisodeEndNumber = 3,
                Timestamp = 12.5
            });

            Assert.IsType<OkObjectResult>(result);
            var persisted = State().Bookmarks["episode"];
            Assert.Equal(1, persisted.IdentityVersion);
            Assert.Equal("episode", persisted.ItemType);
            Assert.Equal("series-tmdb", persisted.SeriesTmdbId);
            Assert.Equal(0, persisted.SeasonNumber);
            Assert.Equal(3, persisted.EpisodeEndNumber);
        }

        [Fact]
        public void AtomicAddThenStaleFullSnapshot_ReturnsConflictAndPreservesAcknowledgedAdd()
        {
            Seed(("a", Bookmark("item-a")));

            var added = Controller().AddUserBookmark(UserId, new UserSettingsController.AddBookmarkPayload
            {
                Revision = 0,
                BookmarkId = "b",
                ItemId = "item-b"
            });
            var addOk = Assert.IsType<OkObjectResult>(added);
            var addResponse = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(addOk.Value);
            Assert.Equal(1, addResponse.Revision);
            Assert.Contains("b", addResponse.Bookmarks);

            var staleController = Controller();
            staleController.Request.Headers["If-Match"] = "\"0\"";
            var stale = staleController.SaveUserBookmark(UserId, new UserBookmark
            {
                Revision = 0,
                Bookmarks = new Dictionary<string, BookmarkItem>
                {
                    ["a"] = Bookmark("item-a"),
                    ["c"] = Bookmark("item-c")
                }
            });

            var conflict = Assert.IsType<ConflictObjectResult>(stale);
            var conflictResponse = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(conflict.Value);
            Assert.True(conflictResponse.Conflict);
            Assert.Equal(1, conflictResponse.Revision);
            Assert.Equal("\"1\"", staleController.Response.Headers.ETag.ToString());

            var final = State();
            Assert.Equal(1, final.Revision);
            Assert.Equal(new[] { "a", "b" }, final.Bookmarks.Keys.OrderBy(key => key).ToArray());
            Assert.DoesNotContain("c", final.Bookmarks);
        }

        [Fact]
        public void FullReplacement_RequiresMatchingStrongRevisionPrecondition()
        {
            Seed(("a", Bookmark("item-a")));
            var noHeader = Controller().SaveUserBookmark(UserId, new UserBookmark
            {
                Revision = 0,
                Bookmarks = new Dictionary<string, BookmarkItem>()
            });
            Assert.Equal(StatusCodes.Status428PreconditionRequired, Assert.IsType<ObjectResult>(noHeader).StatusCode);

            var unquoted = Controller();
            unquoted.Request.Headers["If-Match"] = "0";
            var notStrong = unquoted.SaveUserBookmark(UserId, new UserBookmark
            {
                Revision = 0,
                Bookmarks = new Dictionary<string, BookmarkItem>()
            });
            Assert.Equal(StatusCodes.Status428PreconditionRequired, Assert.IsType<ObjectResult>(notStrong).StatusCode);

            var mismatched = Controller();
            mismatched.Request.Headers["If-Match"] = "\"0\"";
            var bad = mismatched.SaveUserBookmark(UserId, new UserBookmark
            {
                Revision = 1,
                Bookmarks = new Dictionary<string, BookmarkItem>()
            });
            Assert.IsType<BadRequestObjectResult>(bad);
            Assert.Contains("a", State().Bookmarks);
            Assert.Equal(0, State().Revision);
        }

        [Fact]
        public void FullReplacementAndGet_RoundTripOpaqueIdsAndDtoProperties()
        {
            Seed(("old", Bookmark("old-item")));
            var ids = new[]
            {
                "Bm_1_AbC",
                "abc",
                "Abc",
                "item-1:12.25",
                ".leading",
                "映画-☕",
                "007",
                "__proto__",
                "toString",
                "constructor",
                "hasOwnProperty"
            };
            var replacement = ids.ToDictionary(
                id => id,
                id => Bookmark("item-" + id),
                StringComparer.Ordinal);
            var controller = Controller();
            controller.Request.Headers["If-Match"] = "\"0\"";

            var saved = controller.SaveUserBookmark(UserId, new UserBookmark
            {
                Revision = 0,
                Bookmarks = replacement
            });

            var saveResponse = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(saved).Value);
            Assert.Equal(1, saveResponse.Revision);
            var sortedIds = ids.OrderBy(id => id, StringComparer.Ordinal).ToArray();
            Assert.Equal(sortedIds, saveResponse.Bookmarks.Keys);

            var persisted = State();
            Assert.Equal(sortedIds, persisted.Bookmarks.Keys);
            Assert.Equal("item-abc", persisted.Bookmarks["abc"].ItemId);
            Assert.Equal("item-Abc", persisted.Bookmarks["Abc"].ItemId);

            var getController = Controller();
            var get = Assert.IsType<UserBookmark>(
                Assert.IsType<OkObjectResult>(getController.GetUserBookmark(UserId)).Value);
            Assert.Equal(sortedIds, get.Bookmarks.Keys);
            Assert.Equal("\"1\"", getController.Response.Headers.ETag.ToString());

            // Pin the real wire/file boundary: dictionary names remain exact,
            // while the value remains a PascalCase BookmarkItem DTO.
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(get));
            var bookmarkObject = json.RootElement.GetProperty("Bookmarks");
            Assert.Equal(sortedIds, bookmarkObject.EnumerateObject().Select(property => property.Name));
            Assert.Equal("item-Abc", bookmarkObject.GetProperty("Abc").GetProperty("ItemId").GetString());
            Assert.False(bookmarkObject.GetProperty("Abc").TryGetProperty("itemId", out _));
        }

        [Fact]
        public void InvalidBatch_IsAllOrNothing()
        {
            Seed(("a", Bookmark("item-a")));
            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Add("b", "item-b"),
                    new UserSettingsController.BookmarkOperationPayload { Type = "explode", BookmarkId = "x" }
                }
            });

            Assert.IsType<BadRequestObjectResult>(result);
            var final = State();
            Assert.Equal(0, final.Revision);
            Assert.Equal(new[] { "a" }, final.Bookmarks.Keys);
        }

        [Fact]
        public void Batch_RoundTripsVersionedEpisodeIdentityThroughCloneAndPersistence()
        {
            Seed();
            var episode = Bookmark("episode-a");
            episode.IdentityVersion = 1;
            episode.ItemType = "episode";
            episode.MediaType = "tv";
            episode.TmdbId = "episode-tmdb";
            episode.TvdbId = "episode-tvdb";
            episode.SeriesTmdbId = "series-tmdb";
            episode.SeriesTvdbId = "series-tvdb";
            episode.SeasonNumber = 0;
            episode.EpisodeNumber = 2;
            episode.EpisodeEndNumber = 3;

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new UserSettingsController.BookmarkOperationPayload
                    {
                        Type = "add",
                        BookmarkId = "special",
                        Bookmark = episode
                    }
                }
            });

            Assert.IsType<OkObjectResult>(result);
            var persisted = State().Bookmarks["special"];
            Assert.Equal(1, persisted.IdentityVersion);
            Assert.Equal("episode", persisted.ItemType);
            Assert.Equal("episode-tmdb", persisted.TmdbId);
            Assert.Equal("series-tmdb", persisted.SeriesTmdbId);
            Assert.Equal(0, persisted.SeasonNumber);
            Assert.Equal(2, persisted.EpisodeNumber);
            Assert.Equal(3, persisted.EpisodeEndNumber);
        }

        [Theory]
        [InlineData(2, 2, 3)]
        [InlineData(1, 3, 2)]
        public void InvalidVersionOrEpisodeRange_IsRejected(int version, int start, int end)
        {
            Seed();
            var episode = Bookmark("episode-a");
            episode.IdentityVersion = version;
            episode.ItemType = "episode";
            episode.EpisodeNumber = start;
            episode.EpisodeEndNumber = end;

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new UserSettingsController.BookmarkOperationPayload
                    {
                        Type = "add",
                        BookmarkId = "invalid",
                        Bookmark = episode
                    }
                }
            });

            Assert.IsType<BadRequestObjectResult>(result);
            Assert.Empty(State().Bookmarks);
            Assert.Equal(0, State().Revision);
        }

        [Fact]
        public void OversizedBookmarkInput_IsRejectedWithoutChangingRevision()
        {
            Seed(("a", Bookmark("item-a")));
            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Add(new string('x', 257), "item-b")
                }
            });

            Assert.IsType<BadRequestObjectResult>(result);
            var final = State();
            Assert.Equal(0, final.Revision);
            Assert.Equal(new[] { "a" }, final.Bookmarks.Keys);
        }

        [Fact]
        public void AddBeyondSupportedBookmarkCount_IsRejectedWithoutChangingRevision()
        {
            var existing = Enumerable.Range(0, 1000).ToDictionary(
                index => $"bookmark-{index:D4}",
                index => Bookmark($"item-{index:D4}"),
                StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 7,
                Bookmarks = existing
            });

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 7,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new()
                    {
                        Type = "update",
                        BookmarkId = "bookmark-0000",
                        Bookmark = Bookmark("item-0000", "must-roll-back")
                    },
                    Add("bookmark-over-limit", "item-over-limit")
                }
            });

            var rejected = Assert.IsType<ObjectResult>(result);
            Assert.Equal(StatusCodes.Status413PayloadTooLarge, rejected.StatusCode);
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(rejected.Value);
            Assert.Contains("1,000", response.Message, StringComparison.Ordinal);

            var final = State();
            Assert.Equal(7, final.Revision);
            Assert.Equal(1000, final.Bookmarks.Count);
            Assert.Equal(string.Empty, final.Bookmarks["bookmark-0000"].Label);
            Assert.DoesNotContain("bookmark-over-limit", final.Bookmarks);
        }

        [Fact]
        public void FullReplacementBeyondSupportedBookmarkCount_IsRejectedWithoutChangingRevision()
        {
            Seed(("keep", Bookmark("item-keep")));
            var added = Controller().AddUserBookmark(UserId, new UserSettingsController.AddBookmarkPayload
            {
                Revision = 0,
                BookmarkId = "also-keep",
                ItemId = "item-also-keep"
            });
            Assert.IsType<OkObjectResult>(added);
            var controller = Controller();
            controller.Request.Headers.IfMatch = "\"1\"";
            var replacement = new UserBookmark
            {
                Revision = 1,
                Bookmarks = Enumerable.Range(0, 1001).ToDictionary(
                    index => $"bookmark-{index:D4}",
                    index => Bookmark($"item-{index:D4}"),
                    StringComparer.Ordinal)
            };

            var result = controller.SaveUserBookmark(UserId, replacement);

            var rejected = Assert.IsType<ObjectResult>(result);
            Assert.Equal(StatusCodes.Status413PayloadTooLarge, rejected.StatusCode);
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(rejected.Value);
            Assert.Equal(1, response.Revision);
            Assert.Equal("\"1\"", controller.Response.Headers.ETag.ToString());

            var invalidController = Controller();
            invalidController.Request.Headers.IfMatch = "\"1\"";
            var invalid = invalidController.SaveUserBookmark(UserId, new UserBookmark
            {
                Revision = 1,
                Bookmarks = new Dictionary<string, BookmarkItem>(StringComparer.Ordinal)
                {
                    ["invalid"] = Bookmark(new string('i', PersistedPayloadPolicy.MaximumBookmarkItemIdLength + 1))
                }
            });
            var invalidResponse = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<BadRequestObjectResult>(invalid).Value);
            Assert.Equal(1, invalidResponse.Revision);
            Assert.Equal("\"1\"", invalidController.Response.Headers.ETag.ToString());

            Assert.Equal(1, State().Revision);
            Assert.Equal(new[] { "also-keep", "keep" }, State().Bookmarks.Keys.OrderBy(key => key).ToArray());
        }

        [Fact]
        public void OversizedBookmarkLabel_IsRejectedWithoutChangingRevision()
        {
            Seed(("keep", Bookmark("item-keep", "unchanged")));

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new UserSettingsController.BookmarkOperationPayload
                    {
                        Type = "add",
                        BookmarkId = "oversized",
                        Bookmark = Bookmark("item-new", new string('x', 513))
                    }
                }
            });

            Assert.IsType<BadRequestObjectResult>(result);
            var final = State();
            Assert.Equal(0, final.Revision);
            Assert.Equal(new[] { "keep" }, final.Bookmarks.Keys);
            Assert.Equal("unchanged", final.Bookmarks["keep"].Label);
        }

        [Fact]
        public void PagedListing_UsesStableOrderHardCapAndExactItemSearch()
        {
            var bookmarks = Enumerable.Range(0, 205).ToDictionary(
                index => $"bookmark-{index:D4}",
                index => Bookmark(index == 137 ? "target-item" : $"item-{index:D4}"),
                StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 3,
                Bookmarks = bookmarks
            });

            var pageResult = Controller().GetUserBookmarkPage(UserId, startIndex: 100, limit: 100);
            var page = Assert.IsType<UserSettingsController.BookmarkPageResponse>(
                Assert.IsType<OkObjectResult>(pageResult).Value);
            Assert.Equal(3, page.Revision);
            Assert.Equal(205, page.Total);
            Assert.Equal(100, page.StartIndex);
            Assert.Equal(100, page.Limit);
            Assert.True(page.HasMore);
            Assert.Equal(100, page.Bookmarks.Count);
            Assert.Equal("bookmark-0100", page.Bookmarks.Keys.First());
            Assert.Equal("bookmark-0199", page.Bookmarks.Keys.Last());

            var searchResult = Controller().GetUserBookmarkPage(
                UserId,
                startIndex: 0,
                limit: 100,
                itemId: "target-item");
            var search = Assert.IsType<UserSettingsController.BookmarkPageResponse>(
                Assert.IsType<OkObjectResult>(searchResult).Value);
            Assert.Equal(1, search.Total);
            Assert.False(search.HasMore);
            Assert.Equal(new[] { "bookmark-0137" }, search.Bookmarks.Keys);

            var overCap = Controller().GetUserBookmarkPage(UserId, startIndex: 0, limit: 101);
            Assert.IsType<BadRequestObjectResult>(overCap);
        }

        [Theory]
        [InlineData(1)]
        [InlineData(100)]
        [InlineData(1000)]
        public void PagedListingAndSearch_EnforcePayloadAllocationAndTimeBudgets(int count)
        {
            var bookmarks = Enumerable.Range(0, count).ToDictionary(
                index => $"bookmark-{index:D4}",
                index => Bookmark(index == count - 1 ? "target-item" : $"item-{index:D4}"),
                StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 2,
                Bookmarks = bookmarks
            });
            Assert.Equal(count, _manager.GetBookmarkCounts(UserId).Total);

            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();
            var pageResult = Controller().GetUserBookmarkPage(
                UserId,
                startIndex: 0,
                limit: 100,
                mediaType: "movie");
            stopwatch.Stop();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            var page = Assert.IsType<UserSettingsController.BookmarkPageResponse>(
                Assert.IsType<OkObjectResult>(pageResult).Value);
            var pageBytes = JsonSerializer.SerializeToUtf8Bytes(page).Length;

            var searchStopwatch = Stopwatch.StartNew();
            var searchResult = Controller().GetUserBookmarkPage(
                UserId,
                startIndex: 0,
                limit: 100,
                itemId: "target-item");
            searchStopwatch.Stop();
            var search = Assert.IsType<UserSettingsController.BookmarkPageResponse>(
                Assert.IsType<OkObjectResult>(searchResult).Value);
            var searchBytes = JsonSerializer.SerializeToUtf8Bytes(search).Length;

            _output.WriteLine(
                "bookmark_list_count={0}; rows={1}; payload_bytes={2}; allocated_bytes={3}; elapsed_ms={4:F3}; "
                + "search_rows={5}; search_payload_bytes={6}; search_elapsed_ms={7:F3}; requests=2",
                count,
                page.Bookmarks.Count,
                pageBytes,
                allocated,
                stopwatch.Elapsed.TotalMilliseconds,
                search.Bookmarks.Count,
                searchBytes,
                searchStopwatch.Elapsed.TotalMilliseconds);

            Assert.Equal(count, page.AllTotal);
            Assert.Equal(Math.Min(count, 100), page.Bookmarks.Count);
            Assert.Single(search.Bookmarks);
            Assert.InRange(pageBytes, 1, 64 * 1024);
            Assert.InRange(searchBytes, 1, 4 * 1024);
            Assert.InRange(allocated, 1, 1024 * 1024);
            Assert.InRange(stopwatch.Elapsed.TotalMilliseconds, 0, 250);
            Assert.InRange(searchStopwatch.Elapsed.TotalMilliseconds, 0, 250);
        }

        [Fact]
        public void PagedListingAndCounts_ClassifyEveryLegacyMediaAlias()
        {
            var aliases = new[]
            {
                (Id: "movie", Type: "Movie"),
                (Id: "film", Type: "FILM"),
                (Id: "music-video", Type: "MusicVideo"),
                (Id: "tv", Type: "TV"),
                (Id: "series", Type: "Series"),
                (Id: "season", Type: "SEASON"),
                (Id: "episode", Type: "Episode"),
                (Id: "spaced-episode", Type: " Episode "),
                (Id: "tv-show", Type: "TvShow"),
                (Id: "other", Type: "Video")
            };
            Seed(aliases.Select(entry =>
            {
                var bookmark = Bookmark("item-" + entry.Id);
                bookmark.MediaType = entry.Type;
                return (entry.Id, bookmark);
            }).ToArray());

            var counts = _manager.GetBookmarkCounts(UserId);
            Assert.Equal((10, 3, 6, 1), (counts.Total, counts.Movie, counts.Tv, counts.Other));

            UserSettingsController.BookmarkPageResponse Page(string mediaType)
                => Assert.IsType<UserSettingsController.BookmarkPageResponse>(
                    Assert.IsType<OkObjectResult>(Controller().GetUserBookmarkPage(
                        UserId, startIndex: 0, limit: 100, mediaType: mediaType)).Value);

            Assert.Equal(new[] { "film", "movie", "music-video" }, Page("movie").Bookmarks.Keys);
            Assert.Equal(new[] { "episode", "season", "series", "spaced-episode", "tv", "tv-show" }, Page("tv").Bookmarks.Keys);
            Assert.Equal(new[] { "other" }, Page("other").Bookmarks.Keys);
        }

        [Fact]
        public void BatchItemResolution_UsesOneHardCappedRequestAndKeepsFailureKindsDistinct()
        {
            var ids = Enumerable.Range(0, 100).Select(_ => Guid.NewGuid()).ToArray();
            var absent = ids[10];
            var hidden = ids[20];
            var transient = ids[30];
            _libraryManager.GetItemByIdHook = id =>
            {
                if (id == absent) return null;
                if (id == transient) throw new IOException("temporary");
                return new StubMovie { Id = id, Name = "Movie " + id.ToString("N") };
            };
            _libraryManager.GetItemByIdUserHook = (id, _) =>
                id == hidden ? null : new StubMovie { Id = id, Name = "Visible" };

            var result = Controller().ResolveBookmarkItems(
                UserId,
                new UserSettingsController.BookmarkItemResolutionPayload
                {
                    ItemIds = ids.Select(id => id.ToString("N")).ToList()
                },
                CancellationToken.None);
            var response = Assert.IsType<UserSettingsController.BookmarkItemResolutionResponse>(
                Assert.IsType<OkObjectResult>(result).Value);

            Assert.Equal(100, response.Items.Count);
            Assert.Equal("notFound", response.Items[10].Status);
            Assert.Equal("forbidden", response.Items[20].Status);
            Assert.Equal("transient", response.Items[30].Status);
            Assert.Equal("exists", response.Items[0].Status);
            Assert.Equal(100, _libraryManager.GetItemByIdCallCount);
            Assert.Equal(98, _libraryManager.GetItemByIdUserCallCount);

            var overCap = Controller().ResolveBookmarkItems(
                UserId,
                new UserSettingsController.BookmarkItemResolutionPayload
                {
                    ItemIds = Enumerable.Range(0, 101).Select(_ => Guid.NewGuid().ToString("N")).ToList()
                },
                CancellationToken.None);
            Assert.IsType<BadRequestObjectResult>(overCap);
        }

        [Fact]
        public void PagedListing_KeepsLegacyOversizedTextReadableForRepair()
        {
            Seed(("legacy", Bookmark("legacy-item", new string('x', 513))));

            var result = Controller().GetUserBookmarkPage(UserId);

            var page = Assert.IsType<UserSettingsController.BookmarkPageResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
            Assert.Equal(513, page.Bookmarks["legacy"].Label.Length);
        }

        [Fact]
        public void CompactBatchReceipt_DoesNotRepublishCompleteBookmarkMap()
        {
            var bookmarks = Enumerable.Range(0, 100).ToDictionary(
                index => $"bookmark-{index:D4}",
                index => Bookmark($"item-{index:D4}"),
                StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 4,
                Bookmarks = bookmarks
            });

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 4,
                CompactResponse = true,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Add("bookmark-new", "item-new")
                }
            });

            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
            Assert.True(response.Success);
            Assert.False(response.CompleteState);
            Assert.Empty(response.Bookmarks);
            Assert.Equal(5, response.Revision);
            Assert.Equal(101, State().Bookmarks.Count);
            Assert.Contains("bookmark-new", State().Bookmarks);
            var receiptBytes = JsonSerializer.SerializeToUtf8Bytes(response).Length;
            var completeStateBytes = JsonSerializer.SerializeToUtf8Bytes(State()).Length;
            Assert.True(receiptBytes * 10 < completeStateBytes,
                $"compact receipt {receiptBytes} bytes must stay below one tenth of {completeStateBytes}-byte state");

            var staleResult = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 4,
                CompactResponse = true,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Add("stale-add", "stale-item")
                }
            });
            var conflict = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<ConflictObjectResult>(staleResult).Value);
            Assert.True(conflict.Conflict);
            Assert.True(conflict.CompleteState);
            Assert.Equal(101, conflict.Bookmarks.Count);
            Assert.Contains("bookmark-new", conflict.Bookmarks);
            Assert.DoesNotContain("stale-add", conflict.Bookmarks);
        }

        [Fact]
        public void CompactOffsetBatch_UpdatesSupportedMaximumAtomicallyWithinBudgets()
        {
            var bookmarks = Enumerable.Range(0, PersistedPayloadPolicy.MaximumBookmarks).ToDictionary(
                index => $"bookmark-{index:D4}",
                index =>
                {
                    var bookmark = Bookmark($"item-{index:D4}");
                    bookmark.Timestamp = index;
                    bookmark.SyncedFrom = "source-item";
                    return bookmark;
                },
                StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 0,
                Bookmarks = bookmarks
            });
            Assert.Equal(PersistedPayloadPolicy.MaximumBookmarks, _manager.GetBookmarkCounts(UserId).Total);
            var payload = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                CompactResponse = true,
                Operations = Enumerable.Range(0, PersistedPayloadPolicy.MaximumBookmarks)
                    .Select(index => Offset($"bookmark-{index:D4}", index + 5))
                    .ToList()
            };
            var requestBytes = JsonSerializer.SerializeToUtf8Bytes(payload).Length;
            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();

            var result = Controller().BatchUserBookmarks(UserId, payload);

            stopwatch.Stop();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
            var state = State();
            _output.WriteLine(
                "bookmark_offset_count={0}; request_bytes={1}; allocated_bytes={2}; elapsed_ms={3:F3}; requests=1",
                payload.Operations.Count,
                requestBytes,
                allocated,
                stopwatch.Elapsed.TotalMilliseconds);

            Assert.True(response.Success);
            Assert.False(response.CompleteState);
            Assert.Empty(response.Bookmarks);
            Assert.Equal(1, response.Revision);
            Assert.Equal(PersistedPayloadPolicy.MaximumBookmarks, state.Bookmarks.Count);
            Assert.All(state.Bookmarks, pair =>
            {
                var index = int.Parse(pair.Key.AsSpan("bookmark-".Length));
                Assert.Equal(index + 5, pair.Value.Timestamp);
                Assert.Equal(string.Empty, pair.Value.SyncedFrom);
                Assert.Equal("2026-02-01T00:00:00.000Z", pair.Value.UpdatedAt);
            });
            Assert.InRange(requestBytes, 1, 192 * 1024);
            Assert.InRange(allocated, 1, 16 * 1024 * 1024);
            Assert.InRange(stopwatch.Elapsed.TotalMilliseconds, 0, 2000);
        }

        [Fact]
        public void CompactMoveBatch_MovesSupportedMaximumSourcesInOneOperationEach()
        {
            var longText = new string('x', 302);
            string SourceId(int index) => $"source-{index:D4}-" + new string('s', 20);
            string TargetId(int index) => $"target-{index:D4}-" + new string('t', 20);
            var bookmarks = Enumerable.Range(0, 999).ToDictionary(
                SourceId,
                index =>
                {
                    var bookmark = Bookmark($"item-{index:D4}", longText);
                    bookmark.Name = longText;
                    return bookmark;
                },
                StringComparer.Ordinal);
            var existingTarget = Bookmark("target-item", longText);
            existingTarget.Name = longText;
            bookmarks["target-existing"] = existingTarget;
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 0,
                Bookmarks = bookmarks
            });
            var operations = Enumerable.Range(0, 999).Select(index =>
            {
                var bookmark = Bookmark("target-item", longText);
                bookmark.Name = longText;
                bookmark.Timestamp = 10;
                return Move(SourceId(index), TargetId(index), bookmark);
            }).ToList();

            var payload = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                CompactResponse = true,
                Operations = operations
            };
            var wireBytes = JsonSerializer.SerializeToUtf8Bytes(new
            {
                revision = 0,
                compactResponse = true,
                operations = operations.Select(operation => new
                {
                    type = operation.Type,
                    sourceBookmarkId = operation.SourceBookmarkId,
                    bookmarkId = operation.BookmarkId,
                    bookmark = operation.Bookmark
                })
            }).Length;
            var persistedBytes = _manager.GetBookmarkCounts(UserId).PayloadBytes;

            Assert.InRange(persistedBytes, 1, PersistedPayloadPolicy.BookmarkPersistedBytes);
            Assert.True(
                wireBytes > PersistedPayloadPolicy.BookmarkPersistedBytes,
                $"Expected a valid request larger than the persisted cap; wire={wireBytes}, persisted={persistedBytes}.");
            Assert.True(wireBytes < PersistedPayloadPolicy.BookmarkRequestBytes);

            var result = Controller().BatchUserBookmarks(UserId, payload);

            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
            Assert.Equal(1, response.Revision);
            Assert.Equal(1000, State().Bookmarks.Count);
            Assert.DoesNotContain(SourceId(0), State().Bookmarks);
            Assert.Equal("target-item", State().Bookmarks[TargetId(998)].ItemId);
        }

        [Fact]
        public void MaximumMoveEnvelope_CoversWorstCaseJsonEscapingForEveryBoundedString()
        {
            var escaped = '\u0001';
            string Bounded(int length, int index)
                => new string(escaped, length - 4) + index.ToString("D4");
            var operations = Enumerable.Range(0, 999).Select(index =>
            {
                var bookmark = new BookmarkItem
                {
                    ItemId = Bounded(PersistedPayloadPolicy.MaximumBookmarkItemIdLength, index),
                    IdentityVersion = 1,
                    ItemType = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkTypeLength),
                    TmdbId = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkProviderIdLength),
                    TvdbId = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkProviderIdLength),
                    SeriesTmdbId = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkProviderIdLength),
                    SeriesTvdbId = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkProviderIdLength),
                    MediaType = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkTypeLength),
                    SeasonNumber = 100_000,
                    EpisodeNumber = 100_000,
                    EpisodeEndNumber = 100_000,
                    Name = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkTextLength),
                    Timestamp = double.MaxValue,
                    Label = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkTextLength),
                    CreatedAt = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkTimestampLength),
                    UpdatedAt = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkTimestampLength),
                    SyncedFrom = new string(escaped, PersistedPayloadPolicy.MaximumBookmarkItemIdLength)
                };
                Assert.True(PersistedPayloadPolicy.IsValidBookmarkItem(bookmark));
                return Move(
                    Bounded(PersistedPayloadPolicy.MaximumBookmarkIdLength, index),
                    new string(escaped, PersistedPayloadPolicy.MaximumBookmarkIdLength - 5) + "t" + index.ToString("D4"),
                    bookmark);
            }).ToList();
            var wireBytes = JsonSerializer.SerializeToUtf8Bytes(new
            {
                revision = long.MaxValue,
                compactResponse = true,
                operations = operations.Select(operation => new
                {
                    type = operation.Type,
                    sourceBookmarkId = operation.SourceBookmarkId,
                    bookmarkId = operation.BookmarkId,
                    bookmark = operation.Bookmark
                })
            }).Length;

            Assert.Equal(999, operations.Count);
            Assert.All(operations, operation =>
            {
                Assert.True(PersistedPayloadPolicy.IsValidBookmarkId(operation.SourceBookmarkId));
                Assert.True(PersistedPayloadPolicy.IsValidBookmarkId(operation.BookmarkId));
            });
            Assert.True(wireBytes > 2L * 1024 * 1024);
            Assert.True(wireBytes < PersistedPayloadPolicy.BookmarkRequestBytes);
            Assert.True(PersistedPayloadPolicy.BookmarkRequestBytes < 30_000_000);
        }

        [Fact]
        public void InvalidMove_RollsBackEveryStagedMove()
        {
            Seed(("one", Bookmark("source-one")), ("two", Bookmark("source-two")));
            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Move("one", "target", Bookmark("target-item")),
                    Move("two", "two", Bookmark("target-item"))
                }
            });

            Assert.IsType<BadRequestObjectResult>(result);
            Assert.Equal(new[] { "one", "two" }, State().Bookmarks.Keys.OrderBy(id => id));
            Assert.Equal(0, State().Revision);
        }

        [Fact]
        public void OffsetBatch_InvalidMemberRollsBackEveryRow()
        {
            Seed(("one", Bookmark("item-one")), ("two", Bookmark("item-two")));
            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                CompactResponse = true,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Offset("one", 15),
                    Offset("two", double.NaN)
                }
            });

            Assert.Equal(StatusCodes.Status400BadRequest, Assert.IsType<BadRequestObjectResult>(result).StatusCode);
            var state = State();
            Assert.Equal(0, state.Revision);
            Assert.Equal(10, state.Bookmarks["one"].Timestamp);
            Assert.Equal(10, state.Bookmarks["two"].Timestamp);
        }

        [Theory]
        [InlineData(1)]
        [InlineData(100)]
        [InlineData(1000)]
        public void CompactUpdate_RecordsSupportedScalePayloadAllocationAndTime(int count)
        {
            var bookmarks = Enumerable.Range(0, count).ToDictionary(
                index => $"bookmark-{index:D4}",
                index => Bookmark($"item-{index:D4}"),
                StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 0,
                Bookmarks = bookmarks
            });
            // One-time bounded JSON import is measured separately from the
            // steady-state ordinary mutation budget.
            var migrationAllocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var migrationStopwatch = Stopwatch.StartNew();
            Assert.Equal(count, _manager.GetBookmarkCounts(UserId).Total);
            migrationStopwatch.Stop();
            var migrationAllocated = GC.GetAllocatedBytesForCurrentThread() - migrationAllocatedBefore;
            _output.WriteLine(
                "bookmark_migration_count={0}; allocated_bytes={1}; elapsed_ms={2:F3}",
                count,
                migrationAllocated,
                migrationStopwatch.Elapsed.TotalMilliseconds);
            Assert.InRange(migrationAllocated, 1, 16 * 1024 * 1024);
            Assert.InRange(migrationStopwatch.Elapsed.TotalMilliseconds, 0, 2000);
            var payload = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                CompactResponse = true,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new()
                    {
                        Type = "update",
                        BookmarkId = "bookmark-0000",
                        Bookmark = Bookmark("item-0000", "updated")
                    }
                }
            };
            var requestBytes = JsonSerializer.SerializeToUtf8Bytes(payload).Length;
            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();

            var result = Controller().BatchUserBookmarks(UserId, payload);

            stopwatch.Stop();
            var allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
            var receiptBytes = JsonSerializer.SerializeToUtf8Bytes(response).Length;
            var persistedBytes = _manager.GetBookmarkCounts(UserId).PayloadBytes;
            _output.WriteLine(
                "bookmarks={0}; request_bytes={1}; persisted_bytes={2}; receipt_bytes={3}; "
                + "allocated_bytes={4}; elapsed_ms={5:F3}; requests=1",
                count,
                requestBytes,
                persistedBytes,
                receiptBytes,
                allocatedBytes,
                stopwatch.Elapsed.TotalMilliseconds);

            Assert.False(response.CompleteState);
            Assert.Empty(response.Bookmarks);
            Assert.Equal(1, response.Revision);
            Assert.Equal(count, State().Bookmarks.Count);
            Assert.Equal("updated", State().Bookmarks["bookmark-0000"].Label);
            Assert.InRange(requestBytes, 1, 16 * 1024);
            Assert.InRange(receiptBytes, 1, 1024);
            Assert.InRange(persistedBytes, 1, PersistedPayloadPolicy.BookmarkPersistedBytes);
            Assert.InRange(allocatedBytes, 1, 128 * 1024);
            Assert.InRange(stopwatch.Elapsed.TotalMilliseconds, 0, 250);
        }

        [Fact]
        public async Task TwoTabsAddFromSameRevision_RebaseLoserAndBothPersist()
        {
            Seed(("a", Bookmark("item-a")));
            using var barrier = new Barrier(2);

            async Task<(string Id, IActionResult Result)> AddFromTab(string id)
            {
                return await Task.Run(() =>
                {
                    barrier.SignalAndWait();
                    return (id, Controller().AddUserBookmark(UserId, new UserSettingsController.AddBookmarkPayload
                    {
                        Revision = 0,
                        BookmarkId = id,
                        ItemId = "item-" + id
                    }));
                });
            }

            var firstRound = await Task.WhenAll(AddFromTab("b"), AddFromTab("c"));
            Assert.Single(firstRound, result => result.Result is OkObjectResult);
            var loser = Assert.Single(firstRound, result => result.Result is ConflictObjectResult);
            var revision = State().Revision;

            var retry = Controller().AddUserBookmark(UserId, new UserSettingsController.AddBookmarkPayload
            {
                Revision = revision,
                BookmarkId = loser.Id,
                ItemId = "item-" + loser.Id
            });
            Assert.IsType<OkObjectResult>(retry);

            var final = State();
            Assert.Equal(2, final.Revision);
            Assert.Equal(new[] { "a", "b", "c" }, final.Bookmarks.Keys.OrderBy(key => key).ToArray());
        }

        [Fact]
        public void BatchUpdateExistingBookmark_CommitsUpdatedBookmark()
        {
            Seed(("target", Bookmark("item-target", "old")));

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new UserSettingsController.BookmarkOperationPayload
                    {
                        Type = "update",
                        BookmarkId = "target",
                        Bookmark = Bookmark("item-target", "new")
                    }
                }
            });

            var ok = Assert.IsType<OkObjectResult>(result);
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(ok.Value);
            Assert.True(response.Success);
            Assert.Equal(1, response.Revision);
            Assert.Equal("new", response.Bookmarks["target"].Label);

            var final = State();
            Assert.Equal(1, final.Revision);
            Assert.Equal("new", final.Bookmarks["target"].Label);
        }

        [Fact]
        public void BatchUpdateMissingBookmark_ReturnsNotFoundWithoutChangingState()
        {
            Seed(("keep", Bookmark("item-keep", "unchanged")));

            var result = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new UserSettingsController.BookmarkOperationPayload
                    {
                        Type = "update",
                        BookmarkId = "missing",
                        Bookmark = Bookmark("item-missing", "new")
                    }
                }
            });

            var notFound = Assert.IsType<NotFoundObjectResult>(result);
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(notFound.Value);
            Assert.False(response.Success);
            Assert.Equal(0, response.Revision);
            Assert.Contains("does not exist", response.Message, StringComparison.Ordinal);
            Assert.Equal(new[] { "keep" }, response.Bookmarks.Keys);

            var final = State();
            Assert.Equal(0, final.Revision);
            Assert.Equal(new[] { "keep" }, final.Bookmarks.Keys);
            Assert.Equal("unchanged", final.Bookmarks["keep"].Label);
        }

        [Fact]
        public async Task ConcurrentUpdateDelete_DoesNotResurrectDeletedBookmark()
        {
            Seed(("target", Bookmark("item-target", "old")));
            using var barrier = new Barrier(2);

            var updatePayload = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    new UserSettingsController.BookmarkOperationPayload
                    {
                        Type = "update",
                        BookmarkId = "target",
                        Bookmark = Bookmark("item-target", "new")
                    }
                }
            };
            var deletePayload = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload> { Delete("target") }
            };

            Task<IActionResult> Run(UserSettingsController.BookmarkBatchPayload payload) => Task.Run(() =>
            {
                barrier.SignalAndWait();
                return Controller().BatchUserBookmarks(UserId, payload);
            });

            var firstRound = await Task.WhenAll(Run(updatePayload), Run(deletePayload));
            Assert.Single(firstRound, result => result is ConflictObjectResult);

            if (State().Bookmarks.ContainsKey("target"))
            {
                deletePayload.Revision = State().Revision;
                Assert.IsType<OkObjectResult>(Controller().BatchUserBookmarks(UserId, deletePayload));
            }
            else
            {
                updatePayload.Revision = State().Revision;
                Assert.IsType<NotFoundObjectResult>(Controller().BatchUserBookmarks(UserId, updatePayload));
            }

            Assert.DoesNotContain("target", State().Bookmarks);
        }

        [Fact]
        public async Task ConcurrentMigrationCleanup_RebaseCommitsBothCompleteTransactions()
        {
            Seed(
                ("old", Bookmark("old-item")),
                ("orphan", Bookmark("gone-item")),
                ("keep", Bookmark("keep-item")));
            using var barrier = new Barrier(2);
            var migration = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Add("new", "new-item"),
                    Delete("old")
                }
            };
            var cleanup = new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload> { Delete("orphan") }
            };

            async Task<(UserSettingsController.BookmarkBatchPayload Payload, IActionResult Result)> Run(
                UserSettingsController.BookmarkBatchPayload payload)
            {
                return await Task.Run(() =>
                {
                    barrier.SignalAndWait();
                    return (payload, Controller().BatchUserBookmarks(UserId, payload));
                });
            }

            var firstRound = await Task.WhenAll(Run(migration), Run(cleanup));
            var loser = Assert.Single(firstRound, result => result.Result is ConflictObjectResult);
            loser.Payload.Revision = State().Revision;
            Assert.IsType<OkObjectResult>(Controller().BatchUserBookmarks(UserId, loser.Payload));

            var final = State();
            Assert.Equal(2, final.Revision);
            Assert.Equal(new[] { "keep", "new" }, final.Bookmarks.Keys.OrderBy(key => key).ToArray());
        }

        [Fact]
        public void Cleanup_MixedExistenceResults_DeleteOnlyGlobalAbsenceAndRemainIdempotent()
        {
            var gone = Guid.NewGuid();
            var visible = Guid.NewGuid();
            var hidden = Guid.NewGuid();
            var transient = Guid.NewGuid();
            Seed(
                ("gone-a", Bookmark(gone.ToString("N"))),
                ("gone-b", Bookmark(gone.ToString("N"))),
                ("visible", Bookmark(visible.ToString("N"))),
                ("hidden", Bookmark(hidden.ToString("N"))),
                ("transient", Bookmark(transient.ToString("N"))),
                ("malformed", Bookmark("not-a-jellyfin-guid")));

            var globalLookups = 0;
            var scopedLookups = 0;
            _libraryManager.GetItemByIdHook = id =>
            {
                globalLookups++;
                if (id == gone) return null;
                if (id == transient) throw new IOException("temporary library database failure");
                return new StubMovie { Id = id };
            };
            _libraryManager.GetItemByIdUserHook = (id, _) =>
            {
                scopedLookups++;
                return id == hidden ? null : new StubMovie { Id = id };
            };

            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();
            var first = Controller().CleanupUserBookmarks(
                UserId,
                new UserSettingsController.BookmarkCleanupPayload { Revision = 0, CompactResponse = true },
                CancellationToken.None);
            stopwatch.Stop();
            var allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            var firstResponse = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(first).Value);
            _output.WriteLine(
                "cleanup_bookmarks=6; duplicate_item_bookmarks=2; global_lookups={0}; scoped_lookups={1}; "
                + "requests=1; allocated_bytes={2}; elapsed_ms={3:F3}; deleted={4}; transient_failures=1",
                globalLookups,
                scopedLookups,
                allocatedBytes,
                stopwatch.Elapsed.TotalMilliseconds,
                firstResponse.Deleted);

            Assert.Equal(2, firstResponse.Deleted);
            Assert.Equal(3, firstResponse.RetainedUncertain);
            Assert.Equal(2, firstResponse.Errors);
            Assert.Equal(1, firstResponse.Revision);
            Assert.False(firstResponse.CompleteState);
            Assert.Empty(firstResponse.Bookmarks);
            Assert.Equal(new[] { "gone-a", "gone-b" }, firstResponse.DeletedBookmarkIds);
            Assert.Equal(4, globalLookups);
            Assert.Equal(2, scopedLookups);
            var firstStateKeys = State().Bookmarks.Keys.OrderBy(key => key).ToArray();
            Assert.Equal(
                new[] { "hidden", "malformed", "transient", "visible" },
                firstStateKeys);

            // Regaining visibility must not turn the retained bookmark into a
            // deletion candidate. Repeating cleanup is a no-op revision-wise.
            _libraryManager.GetItemByIdUserHook = (id, _) => new StubMovie { Id = id };
            var second = Controller().CleanupUserBookmarks(
                UserId,
                new UserSettingsController.BookmarkCleanupPayload { Revision = 1 },
                CancellationToken.None);
            var secondResponse = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(second).Value);

            Assert.Equal(0, secondResponse.Deleted);
            Assert.Equal(2, secondResponse.RetainedUncertain);
            Assert.Equal(2, secondResponse.Errors);
            Assert.Equal(1, secondResponse.Revision);
            Assert.Equal(firstStateKeys, secondResponse.Bookmarks.Keys.OrderBy(key => key));
        }

        [Fact]
        public void Cleanup_SupportedMaximumWithDuplicatesAndTransientFailures_StaysWithinBatchBudgets()
        {
            var itemIds = Enumerable.Range(0, 100).Select(_ => Guid.NewGuid()).ToArray();
            var bookmarks = itemIds.SelectMany((itemId, itemIndex) =>
                    Enumerable.Range(0, 10).Select(bookmarkIndex => new
                    {
                        Id = $"bookmark-{itemIndex:D3}-{bookmarkIndex:D2}",
                        Bookmark = Bookmark(itemId.ToString("N"))
                    }))
                .ToDictionary(entry => entry.Id, entry => entry.Bookmark, StringComparer.Ordinal);
            _manager.SaveUserConfiguration(UserId, "bookmark.json", new UserBookmark
            {
                Revision = 0,
                Bookmarks = bookmarks
            });
            Assert.Equal(1000, _manager.GetBookmarkCounts(UserId).Total);
            var absent = itemIds.Take(25).ToHashSet();
            var transient = itemIds.Skip(25).Take(25).ToHashSet();
            _libraryManager.GetItemByIdHook = id =>
            {
                if (absent.Contains(id)) return null;
                if (transient.Contains(id)) throw new IOException("temporary");
                return new StubMovie { Id = id };
            };
            _libraryManager.GetItemByIdUserHook = (id, _) => new StubMovie { Id = id };

            var allocatedBefore = GC.GetAllocatedBytesForCurrentThread();
            var stopwatch = Stopwatch.StartNew();
            var result = Controller().CleanupUserBookmarks(
                UserId,
                new UserSettingsController.BookmarkCleanupPayload
                {
                    Revision = 0,
                    CompactResponse = true,
                    Limit = 100
                },
                CancellationToken.None);
            stopwatch.Stop();
            var allocated = GC.GetAllocatedBytesForCurrentThread() - allocatedBefore;
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(result).Value);
            var responseBytes = JsonSerializer.SerializeToUtf8Bytes(response).Length;
            _output.WriteLine(
                "cleanup_bookmarks=1000; distinct_items=100; duplicate_bookmarks_per_item=10; "
                + "global_lookups={0}; scoped_lookups={1}; deleted={2}; retained_uncertain={3}; "
                + "errors={4}; response_bytes={5}; allocated_bytes={6}; elapsed_ms={7:F3}; requests=1",
                _libraryManager.GetItemByIdCallCount,
                _libraryManager.GetItemByIdUserCallCount,
                response.Deleted,
                response.RetainedUncertain,
                response.Errors,
                responseBytes,
                allocated,
                stopwatch.Elapsed.TotalMilliseconds);

            Assert.Equal(250, response.Deleted);
            Assert.Equal(250, response.RetainedUncertain);
            Assert.Equal(25, response.Errors);
            Assert.Equal(100, response.ScannedItems);
            Assert.False(response.HasMore);
            Assert.Equal(100, _libraryManager.GetItemByIdCallCount);
            Assert.Equal(50, _libraryManager.GetItemByIdUserCallCount);
            Assert.Equal(750, State().Bookmarks.Count);
            Assert.InRange(responseBytes, 1, 64 * 1024);
            Assert.InRange(allocated, 1, 4 * 1024 * 1024);
            Assert.InRange(stopwatch.Elapsed.TotalMilliseconds, 0, 500);
        }

        [Fact]
        public void Cleanup_OpaqueCursorIncludesAndClassifiesEmptyLegacyItemIdAcrossPages()
        {
            var visible = Guid.NewGuid();
            Directory.CreateDirectory(Path.GetDirectoryName(BookmarkPath)!);
            File.WriteAllText(BookmarkPath, JsonSerializer.Serialize(new UserBookmark
            {
                Revision = 0,
                Bookmarks = new Dictionary<string, BookmarkItem>(StringComparer.Ordinal)
                {
                    ["empty"] = Bookmark(string.Empty),
                    ["visible"] = Bookmark(visible.ToString("N"))
                }
            }));
            _libraryManager.GetItemByIdHook = id => new StubMovie { Id = id };
            _libraryManager.GetItemByIdUserHook = (id, _) => new StubMovie { Id = id };

            var first = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(Controller().CleanupUserBookmarks(
                    UserId,
                    new UserSettingsController.BookmarkCleanupPayload
                    {
                        Revision = 0,
                        CompactResponse = true,
                        Limit = 1
                    },
                    CancellationToken.None)).Value);

            Assert.Equal(1, first.ScannedItems);
            Assert.Equal(1, first.RetainedUncertain);
            Assert.Equal(1, first.Errors);
            Assert.True(first.HasMore);
            Assert.Equal("v1.", first.NextCursor);

            var second = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<OkObjectResult>(Controller().CleanupUserBookmarks(
                    UserId,
                    new UserSettingsController.BookmarkCleanupPayload
                    {
                        Revision = first.Revision,
                        CompactResponse = true,
                        Limit = 1,
                        Cursor = first.NextCursor
                    },
                    CancellationToken.None)).Value);

            Assert.Equal(1, second.ScannedItems);
            Assert.Equal(0, second.Errors);
            Assert.False(second.HasMore);
            Assert.Equal(new[] { "empty", "visible" }, State().Bookmarks.Keys.OrderBy(id => id));
        }

        [Fact]
        public void Cleanup_CancelledBeforeClassification_PreservesExactState()
        {
            var itemId = Guid.NewGuid();
            Seed(("keep", Bookmark(itemId.ToString("N"))));
            using var cancellation = new CancellationTokenSource();
            cancellation.Cancel();

            var result = Controller().CleanupUserBookmarks(
                UserId,
                new UserSettingsController.BookmarkCleanupPayload { Revision = 0 },
                cancellation.Token);

            Assert.Equal(499, Assert.IsType<ObjectResult>(result).StatusCode);
            Assert.Equal(0, State().Revision);
            Assert.Contains("keep", State().Bookmarks.Keys);
        }

        [Fact]
        public void Cleanup_OverBound_Returns413WithoutAnyLookupOrMutation()
        {
            var state = new UserBookmark
            {
                Revision = 0,
                Bookmarks = Enumerable.Range(0, 1001).ToDictionary(
                    index => $"bookmark-{index}",
                    _ => Bookmark(Guid.NewGuid().ToString("N")),
                    StringComparer.Ordinal)
            };
            _manager.SaveUserConfiguration(UserId, "bookmark.json", state);
            _libraryManager.GetItemByIdHook = _ => throw new InvalidOperationException("lookup must remain bounded");

            var result = Controller().CleanupUserBookmarks(
                UserId,
                new UserSettingsController.BookmarkCleanupPayload { Revision = 0 },
                CancellationToken.None);
            var response = Assert.IsType<UserSettingsController.BookmarkMutationResponse>(
                Assert.IsType<ObjectResult>(result).Value);

            Assert.Equal(StatusCodes.Status413PayloadTooLarge, Assert.IsType<ObjectResult>(result).StatusCode);
            Assert.Equal(0, response.Deleted);
            Assert.Equal(1001, response.RetainedUncertain);
            Assert.Equal(1, response.Errors);
            Assert.Equal(0, State().Revision);
            Assert.Equal(1001, State().Bookmarks.Count);
        }

        [Fact]
        public void FailedGet_BlocksAddDeleteAndMigrationWithoutOverwritingRawStore()
        {
            Seed(("a", Bookmark("item-a")));
            File.WriteAllText(BookmarkPath, "{ malformed bookmark state");
            var raw = File.ReadAllText(BookmarkPath);

            var get = Controller().GetUserBookmark(UserId);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(get).StatusCode);

            var add = Controller().AddUserBookmark(UserId, new UserSettingsController.AddBookmarkPayload
            {
                Revision = 0,
                BookmarkId = "b",
                ItemId = "item-b"
            });
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(add).StatusCode);

            var delete = Controller().RemoveUserBookmark(UserId, "a", 0);
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(delete).StatusCode);

            var migration = Controller().BatchUserBookmarks(UserId, new UserSettingsController.BookmarkBatchPayload
            {
                Revision = 0,
                Operations = new List<UserSettingsController.BookmarkOperationPayload>
                {
                    Add("c", "item-c"),
                    Delete("a")
                }
            });
            Assert.Equal(StatusCodes.Status503ServiceUnavailable, Assert.IsType<ObjectResult>(migration).StatusCode);
            Assert.False(File.Exists(BookmarkPath));
            Assert.True(File.Exists(BookmarkPath + ".unhealthy"));
            Assert.Equal(
                raw,
                File.ReadAllText(Assert.Single(Directory.GetFiles(Path.GetDirectoryName(BookmarkPath)!, "bookmark.json.corrupt-*"))));
        }

        [Fact]
        public void ImmediateQuarantineGroups_AreUniqueAndRetainNewestFive()
        {
            var directory = Path.GetDirectoryName(DatabasePath)!;
            Directory.CreateDirectory(directory);
            var observedSuffixes = new List<string>();

            for (var index = 0; index < 7; index++)
            {
                var before = Directory.GetFiles(directory, "bookmarks.db.corrupt-*")
                    .ToHashSet(StringComparer.Ordinal);
                File.WriteAllText(DatabasePath, $"primary-{index}");
                File.WriteAllText(DatabasePath + "-wal", $"wal-{index}");
                File.WriteAllText(DatabasePath + "-shm", $"shm-{index}");
                var modified = DateTime.UnixEpoch.AddMinutes(index);
                File.SetLastWriteTimeUtc(DatabasePath, modified);
                File.SetLastWriteTimeUtc(DatabasePath + "-wal", modified);
                File.SetLastWriteTimeUtc(DatabasePath + "-shm", modified);

                QuarantineBookmarkDatabaseGroup();

                var after = Directory.GetFiles(directory, "bookmarks.db.corrupt-*");
                var created = Assert.Single(after, path => !before.Contains(path));
                var suffix = created[DatabasePath.Length..];
                Assert.Matches(@"^\.corrupt-\d{17}-[0-9a-f]{32}$", suffix);
                Assert.DoesNotContain(suffix, observedSuffixes);
                observedSuffixes.Add(suffix);
                Assert.True(File.Exists(DatabasePath + "-wal" + suffix));
                Assert.True(File.Exists(DatabasePath + "-shm" + suffix));
            }

            Assert.Equal(7, observedSuffixes.Count);
            Assert.Equal(5, Directory.GetFiles(directory, "bookmarks.db.corrupt-*").Length);
            Assert.Equal(5, Directory.GetFiles(directory, "bookmarks.db-wal.corrupt-*").Length);
            Assert.Equal(5, Directory.GetFiles(directory, "bookmarks.db-shm.corrupt-*").Length);
            Assert.Equal(
                observedSuffixes.Skip(2).Order(StringComparer.Ordinal),
                Directory.GetFiles(directory, "bookmarks.db.corrupt-*")
                    .Select(path => path[DatabasePath.Length..])
                    .Order(StringComparer.Ordinal));
        }

        [Fact]
        public void CorruptPrimary_RestoresLatestVerifiedBackupAndQuarantinesDatabaseGroup()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            Assert.NotEmpty(WaitForDatabaseBackups());
            WaitForBookmarkBackupWorkerIdle();
            ReplacePrimaryBytes("not a sqlite database"u8.ToArray());

            var recovered = NewManager().GetBookmarks(UserId);

            Assert.Contains("preserved", recovered.Bookmarks);
            Assert.NotEmpty(Directory.GetFiles(Path.GetDirectoryName(DatabasePath)!, "bookmarks.db.corrupt-*"));
        }

        [Fact]
        public void MissingPrimary_RestoresBackupAndQuarantinesInterruptedRecoverySidecars()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            WaitForDatabaseBackups();
            WaitForBookmarkBackupWorkerIdle();
            File.Delete(DatabasePath);
            File.WriteAllBytes(DatabasePath + "-wal", new byte[] { 1, 2, 3 });
            File.WriteAllBytes(DatabasePath + "-shm", new byte[] { 4, 5, 6 });

            var recovered = NewManager().GetBookmarks(UserId);

            Assert.Contains("preserved", recovered.Bookmarks);
            Assert.NotEmpty(Directory.GetFiles(Path.GetDirectoryName(DatabasePath)!, "bookmarks.db-wal.corrupt-*"));
            Assert.NotEmpty(Directory.GetFiles(Path.GetDirectoryName(DatabasePath)!, "bookmarks.db-shm.corrupt-*"));
        }

        [Fact]
        public void CorruptPrimaryWithoutValidBackup_FailsClosedAndPreservesQuarantine()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            var backups = WaitForDatabaseBackups();
            WaitForBookmarkBackupWorkerIdle();
            File.Copy(backups[0], DatabasePath + ".backup-99999999999999999.tmp-wal");
            foreach (var backup in backups)
            {
                File.WriteAllBytes(backup, "invalid backup"u8.ToArray());
            }
            ReplacePrimaryBytes("invalid primary"u8.ToArray());

            var failure = Record.Exception(() => NewManager().GetBookmarks(UserId));
            Assert.True(
                failure is InvalidDataException,
                $"Expected invalid backups to fail closed; observed {failure?.GetType().Name ?? "success"}. Backups: "
                + string.Join(", ", Directory.GetFiles(Path.GetDirectoryName(DatabasePath)!, "bookmarks.db.backup-*")
                    .Select(path => $"{Path.GetFileName(path)}={new FileInfo(path).Length}")));
            Assert.NotEmpty(Directory.GetFiles(Path.GetDirectoryName(DatabasePath)!, "bookmarks.db.corrupt-*"));
            Assert.False(File.Exists(DatabasePath));
        }

        [Fact]
        public void ZeroLengthPrimary_RestoresOwnedBackupInsteadOfInitializingEmptyState()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            WaitForDatabaseBackups();
            WaitForBookmarkBackupWorkerIdle();
            ReplacePrimaryBytes(Array.Empty<byte>());

            var recovered = NewManager().GetBookmarks(UserId);

            Assert.Contains("preserved", recovered.Bookmarks);
            Assert.NotEmpty(Directory.GetFiles(Path.GetDirectoryName(DatabasePath)!, "bookmarks.db.corrupt-*"));
        }

        [Fact]
        public void ValidButUnownedSqlitePrimary_RestoresOwnedBackup()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            WaitForDatabaseBackups();
            WaitForBookmarkBackupWorkerIdle();
            File.Delete(DatabasePath + "-wal");
            File.Delete(DatabasePath + "-shm");
            File.Delete(DatabasePath);
            using (var unrelated = new SqliteConnection($"Data Source={DatabasePath}"))
            {
                unrelated.Open();
                using var command = unrelated.CreateCommand();
                command.CommandText = "CREATE TABLE Unrelated (Value TEXT);";
                command.ExecuteNonQuery();
            }

            Assert.Contains("preserved", NewManager().GetBookmarks(UserId).Bookmarks);
        }

        [Fact]
        public void RestoreSkipsNewestSemanticallyInvalidBackup()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            var validBackup = Assert.Single(WaitForDatabaseBackups());
            WaitForBookmarkBackupWorkerIdle();
            var invalidBackup = DatabasePath + ".backup-99999999999999999";
            using (var unrelated = new SqliteConnection($"Data Source={invalidBackup}"))
            {
                unrelated.Open();
                using var command = unrelated.CreateCommand();
                command.CommandText = "CREATE TABLE Unrelated (Value TEXT);";
                command.ExecuteNonQuery();
            }
            File.SetLastWriteTimeUtc(invalidBackup, File.GetLastWriteTimeUtc(validBackup).AddMinutes(1));
            ReplacePrimaryBytes("invalid primary"u8.ToArray());

            Assert.Contains("preserved", NewManager().GetBookmarks(UserId).Bookmarks);
        }

        [Fact]
        public void MetadataDrift_RestoresVerifiedBackup()
        {
            Seed(("preserved", Bookmark("item-preserved")));
            Assert.Contains("preserved", State().Bookmarks);
            WaitForDatabaseBackups();
            WaitForBookmarkBackupWorkerIdle();
            using (var connection = new SqliteConnection($"Data Source={DatabasePath}"))
            {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "UPDATE BookmarkUsers SET BookmarkCount = BookmarkCount + 1;";
                command.ExecuteNonQuery();
            }

            var recovered = NewManager().GetBookmarks(UserId);

            Assert.Single(recovered.Bookmarks);
            Assert.Contains("preserved", recovered.Bookmarks);
        }

        [Fact]
        public void DeferredBackup_CoalescesManyUserImportsOffRequestPath()
        {
            var stopwatch = Stopwatch.StartNew();
            for (var index = 0; index < 100; index++)
            {
                var userId = Guid.NewGuid().ToString("N");
                _manager.SaveUserConfiguration(userId, "bookmark.json", new UserBookmark
                {
                    Bookmarks = new Dictionary<string, BookmarkItem>(StringComparer.Ordinal)
                    {
                        ["bookmark"] = Bookmark($"item-{index:D4}")
                    }
                });
                Assert.Single(_manager.GetBookmarks(userId).Bookmarks);
            }
            stopwatch.Stop();

            Assert.InRange(stopwatch.Elapsed.TotalMilliseconds, 0, 2000);
            Assert.Single(WaitForDatabaseBackups());
        }

        [Fact]
        public void DeferredBackup_CoalescesOrdinaryWritesAfterTheStartupSnapshot()
        {
            Seed(("initial", Bookmark("item-initial")));
            Assert.Single(State().Bookmarks);
            Assert.Single(WaitForDatabaseBackups());
            WaitForBookmarkBackupWorkerIdle();
            MakeBookmarkBackupDue();

            for (var index = 0; index < 20; index++)
            {
                var result = _manager.ApplyBookmarkOperations(
                    UserId,
                    expectedRevision: index,
                    new[]
                    {
                        new BookmarkStoreOperation
                        {
                            Type = "add",
                            BookmarkId = $"ordinary-{index:D4}",
                            Bookmark = Bookmark($"ordinary-item-{index:D4}")
                        }
                    });
                Assert.Equal(BookmarkStoreStatus.Success, result.Status);
                Assert.True(result.Changed);
            }

            Assert.Equal(2, WaitForDatabaseBackups(minimum: 2).Length);
            WaitForBookmarkBackupWorkerIdle();
            Assert.Equal(21, State().Bookmarks.Count);
        }

        [Fact]
        public void OrdinaryWriteRacingSnapshot_RequestsOneRateLimitedFollowUp()
        {
            Seed(("initial", Bookmark("item-initial")));
            Assert.Single(State().Bookmarks);
            Assert.Single(WaitForDatabaseBackups());
            WaitForBookmarkBackupWorkerIdle();
            using (var connection = new SqliteConnection($"Data Source={DatabasePath}"))
            {
                connection.Open();
                using var command = connection.CreateCommand();
                command.CommandText = "CREATE TABLE BackupPadding (Value BLOB); INSERT INTO BackupPadding VALUES (zeroblob(67108864));";
                command.ExecuteNonQuery();
            }
            MakeBookmarkBackupDue();
            Assert.Equal(
                BookmarkStoreStatus.Success,
                _manager.ApplyBookmarkOperations(UserId, 0, new[]
                {
                    new BookmarkStoreOperation { Type = "add", BookmarkId = "before", Bookmark = Bookmark("item-before") }
                }).Status);

            var directory = Path.GetDirectoryName(DatabasePath)!;
            Assert.True(SpinWait.SpinUntil(
                () => Directory.GetFiles(directory, "bookmarks.db.backup-*.tmp").Length > 0,
                TimeSpan.FromSeconds(10)), "Timed out waiting for an in-progress bookmark backup.");
            var generation = BookmarkBackupGeneration();
            Assert.Equal(
                BookmarkStoreStatus.Success,
                _manager.ApplyBookmarkOperations(UserId, 1, new[]
                {
                    new BookmarkStoreOperation { Type = "add", BookmarkId = "during", Bookmark = Bookmark("item-during") }
                }).Status);

            Assert.True(BookmarkBackupGeneration() > generation);
            Assert.True(SpinWait.SpinUntil(
                () => Directory.GetFiles(directory, "bookmarks.db.backup-*.tmp").Length == 0,
                TimeSpan.FromSeconds(10)), "Timed out waiting for the racing bookmark backup to finish.");
            Assert.Equal(2, Directory.GetFiles(directory, "bookmarks.db.backup-*").Length);
            Assert.False(BookmarkBackupWorker()?.IsCompleted ?? true);
        }
    }
}
