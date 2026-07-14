using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

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

        public BookmarkRevisionControllerTests()
        {
            _baseDir = Path.Combine(Path.GetTempPath(), "jc-bookmark-revision-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);
            _user = new User("bookmark-user", "Provider", "PasswordProvider");
        }

        private string UserId => _user.Id.ToString("N");

        private string BookmarkPath => Path.Combine(
            _baseDir,
            "configurations",
            "Jellyfin.Plugin.JellyfinCanopy",
            UserId,
            "bookmark.json");

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
                _manager);
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
            => _manager.GetUserConfigurationStrict<UserBookmark>(UserId, "bookmark.json");

        private static UserSettingsController.BookmarkOperationPayload Add(string id, string itemId)
            => new UserSettingsController.BookmarkOperationPayload
            {
                Type = "add",
                BookmarkId = id,
                Bookmark = Bookmark(itemId)
            };

        private static UserSettingsController.BookmarkOperationPayload Delete(string id)
            => new UserSettingsController.BookmarkOperationPayload { Type = "delete", BookmarkId = id };

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
            Assert.Equal(raw, File.ReadAllText(BookmarkPath));
        }
    }
}
