using System.Diagnostics;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class ReviewsStoreTests : IDisposable
{
    private readonly string _baseDir;
    private readonly ITestOutputHelper _output;

    public ReviewsStoreTests(ITestOutputHelper output)
    {
        _output = output;
        _baseDir = Path.Combine(Path.GetTempPath(), "jc-review-store-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDir);
    }

    private string ConfigDir => Path.Combine(_baseDir, "configurations", "Jellyfin.Plugin.JellyfinCanopy");

    public void Dispose()
    {
        try
        {
            Directory.Delete(_baseDir, recursive: true);
        }
        catch
        {
            // Best effort on test teardown.
        }
    }

    [Theory]
    [InlineData("movie", "1", true, "1")]
    [InlineData("tv", "42:s0:e0", true, "42:s0:e0")]
    [InlineData("tv", "42:s100000:e100000", true, "42:s100000:e100000")]
    [InlineData("movie", "42:s1", false, "")]
    [InlineData("tv", "042:s1", false, "")]
    [InlineData("tv", "42:e1", false, "")]
    [InlineData("tv", "42:s100001", false, "")]
    [InlineData("music", "42", false, "")]
    public void TargetValidation_EnforcesCanonicalMediaNamespace(
        string mediaType,
        string target,
        bool expected,
        string canonical)
    {
        Assert.Equal(expected, ReviewTarget.TryValidate(mediaType, target, out var actual));
        Assert.Equal(canonical, actual);
    }

    [Fact]
    public void ContentQuota_ExactBoundaryAllowsAndNPlusOneRejects()
    {
        Assert.True(ReviewLimits.IsContentWithinLimit(new string('x', ReviewLimits.ContentCharacters)));
        Assert.False(ReviewLimits.IsContentWithinLimit(new string('x', ReviewLimits.ContentCharacters + 1)));
    }

    [Fact]
    public void LegacyMigration_NormalizesAndDeduplicatesThenArchivesJson()
    {
        var user = UserId(1);
        var store = new AllReviewsStore
        {
            Reviews = new Dictionary<string, UserReview>
            {
                [user + ":tv:00042:s01:e002"] = Review(user, "tv", "00042:s01:e002", "older", "2024-01-01T00:00:00Z"),
                [user + ":tv:42:s1:e2"] = Review(user, "tv", "42:s1:e2", "newer", "2024-01-02T00:00:00Z")
            }
        };
        SeedLegacy(store);

        var manager = Manager();
        var migrated = Assert.IsType<UserReview>(manager.GetReview(user, "tv", "42:s1:e2"));

        Assert.Equal("newer", migrated.Content);
        Assert.Equal(1, manager.GetReviewStoreStatus().TotalReviews);
        Assert.False(File.Exists(Path.Combine(ConfigDir, "reviews.json")));
        Assert.Single(Directory.GetFiles(ConfigDir, "reviews.json.migrated-*"));
    }

    [Fact]
    public void PerUserQuota_ExactBoundaryRejectsNPlusOneWithoutMutating()
    {
        var user = UserId(1);
        SeedLegacy(CreateLegacyReviews(ReviewLimits.PerUserReviews, _ => user));
        var manager = Manager();

        Assert.Equal(ReviewLimits.PerUserReviews, manager.GetReviewStoreStatus().TotalReviews);
        var update = manager.UpsertReview(user, "movie", "1", "updated", 5, "2025-01-01T00:00:00Z");
        Assert.Equal(ReviewUpsertOutcome.Updated, update);

        var error = Assert.Throws<ReviewQuotaExceededException>(() =>
            manager.UpsertReview(user, "movie", "1001", "new", 5, "2025-01-01T00:00:00Z"));
        Assert.Equal("review_user_limit", error.Code);
        Assert.Equal(ReviewLimits.PerUserReviews, manager.GetReviewStoreStatus().TotalReviews);
        Assert.Null(manager.GetReview(user, "movie", "1001"));
    }

    [Fact]
    public void TotalQuota_ExactBoundaryAllowsUpdatesButRejectsNewRows()
    {
        SeedLegacy(CreateLegacyReviews(
            ReviewLimits.TotalReviews,
            index => UserId((index / ReviewLimits.PerUserReviews) + 1)));
        var manager = Manager();

        Assert.Equal(ReviewLimits.TotalReviews, manager.GetReviewStoreStatus().TotalReviews);
        Assert.Equal(
            ReviewUpsertOutcome.Updated,
            manager.UpsertReview(UserId(1), "movie", "1", "updated", null, "2025-01-01T00:00:00Z"));

        var error = Assert.Throws<ReviewQuotaExceededException>(() =>
            manager.UpsertReview(UserId(99), "movie", "20000", "new", null, "2025-01-01T00:00:00Z"));
        Assert.Equal("review_total_limit", error.Code);
        Assert.Equal(ReviewLimits.TotalReviews, manager.GetReviewStoreStatus().TotalReviews);
    }

    [Fact]
    public async Task ConcurrentUpserts_AreUniqueDurableAndLastWriterComplete()
    {
        var manager = Manager();
        var user = UserId(1);
        var writes = Enumerable.Range(1, 32)
            .Select(index => Task.Run(() => manager.UpsertReview(
                user,
                "movie",
                "42",
                "content-" + index,
                (index % 5) + 1,
                $"2025-01-01T00:00:{index:00}Z")))
            .ToArray();

        await Task.WhenAll(writes);

        Assert.Equal(1, manager.GetReviewStoreStatus().TotalReviews);
        var saved = Assert.IsType<UserReview>(manager.GetReview(user, "movie", "42"));
        Assert.StartsWith("content-", saved.Content, StringComparison.Ordinal);
        var reopened = Manager();
        Assert.Equal(saved.Content, reopened.GetReview(user, "movie", "42")?.Content);
    }

    [Fact]
    public void ItemAndModerationPages_AreBoundedStableAndComplete()
    {
        const int count = 205;
        var store = new AllReviewsStore();
        for (var index = 1; index <= count; index++)
        {
            var user = UserId(index);
            store.Reviews[user + ":movie:42"] = Review(user, "movie", "42", "content", "2025-01-01T00:00:00Z");
        }

        SeedLegacy(store);
        var manager = Manager();
        var itemReviews = ReadAllPages(cursor => manager.GetItemReviews("movie", "42", 100, cursor));
        var moderationReviews = ReadAllPages(cursor => manager.GetAllReviews(100, cursor));

        Assert.Equal(count, itemReviews.Count);
        Assert.Equal(count, itemReviews.Select(review => review.UserId).Distinct(StringComparer.Ordinal).Count());
        Assert.Equal(count, moderationReviews.Count);
    }

    [Fact]
    public void CorruptDatabase_RecoversFromNewestVerifiedBackupAndRetainsFiveGroups()
    {
        var manager = Manager();
        manager.UpsertReview(UserId(1), "movie", "42", "durable", 5, "2025-01-01T00:00:00Z");

        for (var index = 0; index < ReviewLimits.RetainedBackups + 2; index++)
        {
            Assert.Equal(1, Manager().GetReviewStoreStatus().TotalReviews);
        }

        Assert.Equal(ReviewLimits.RetainedBackups, Directory.GetFiles(ConfigDir, "reviews.db.backup-*").Length);
        File.WriteAllText(Path.Combine(ConfigDir, "reviews.db"), "corrupt");

        var recovered = Manager();
        Assert.Equal("durable", recovered.GetReview(UserId(1), "movie", "42")?.Content);
        Assert.True(Directory.GetFiles(ConfigDir, "reviews.db.corrupt-*").Length <= ReviewLimits.RetainedBackups);
    }

    [Fact]
    public void MissingPrimaryAfterInterruptedRecovery_RestoresBackupInsteadOfCreatingEmptyStore()
    {
        var manager = Manager();
        manager.UpsertReview(UserId(1), "movie", "42", "durable", 5, "2025-01-01T00:00:00Z");
        Assert.Equal(1, Manager().GetReviewStoreStatus().TotalReviews); // verified backup now contains the row

        var database = Path.Combine(ConfigDir, "reviews.db");
        File.Move(database, database + ".corrupt-interrupted");
        File.WriteAllText(database + "-wal", "foreign-wal-from-interrupted-quarantine");
        SeedLegacy(new AllReviewsStore()); // stale pre-publication JSON must not win

        var recovered = Manager();
        Assert.Equal("durable", recovered.GetReview(UserId(1), "movie", "42")?.Content);
        Assert.Equal(1, recovered.GetReviewStoreStatus().TotalReviews);
        Assert.Single(Directory.GetFiles(ConfigDir, "reviews.json.migrated-*"));
        Assert.Single(Directory.GetFiles(ConfigDir, "reviews.db-wal.corrupt-*"));
    }

    [Theory]
    [InlineData(1)]
    [InlineData(100)]
    [InlineData(1000)]
    [InlineData(15000)]
    public void WarmLookupAndUpsert_HaveBoundedAllocationLatencyAndBytesWritten(int count)
    {
        SeedLegacy(CreateLegacyReviews(
            count,
            index => UserId((index / ReviewLimits.PerUserReviews) + 1)));
        var manager = Manager();
        Assert.Equal(count, manager.GetReviewStoreStatus().TotalReviews);
        _ = manager.GetReview(UserId(1), "movie", "1");

        // Keep one observer connection open so SQLite does not delete the WAL
        // when the store's intentionally short-lived writer connection closes.
        // This turns the file-length delta into an actual bytes-written proxy.
        using var observer = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(ConfigDir, "reviews.db"),
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false
            }.ToString());
        observer.Open();
        using var observerTransaction = observer.BeginTransaction(deferred: true);
        using (var snapshot = observer.CreateCommand())
        {
            snapshot.Transaction = observerTransaction;
            snapshot.CommandText = "SELECT COUNT(*) FROM Reviews;";
            _ = snapshot.ExecuteScalar();
        }

        var wal = Path.Combine(ConfigDir, "reviews.db-wal");
        var readAllocationsBefore = GC.GetAllocatedBytesForCurrentThread();
        var readTimer = Stopwatch.StartNew();
        var found = manager.GetReview(UserId(1), "movie", "1");
        readTimer.Stop();
        var readAllocated = GC.GetAllocatedBytesForCurrentThread() - readAllocationsBefore;

        var bytesBefore = File.Exists(wal) ? new FileInfo(wal).Length : 0;
        var writeAllocationsBefore = GC.GetAllocatedBytesForCurrentThread();
        var writeTimer = Stopwatch.StartNew();
        manager.UpsertReview(UserId(1), "movie", "1", "benchmark-update", 4, "2025-01-01T00:00:00Z");
        writeTimer.Stop();
        var writeAllocated = GC.GetAllocatedBytesForCurrentThread() - writeAllocationsBefore;
        var bytesAfter = File.Exists(wal) ? new FileInfo(wal).Length : 0;
        var bytesWritten = Math.Max(0, bytesAfter - bytesBefore);

        Assert.NotNull(found);
        Assert.True(readTimer.Elapsed < TimeSpan.FromSeconds(2), $"Warm item read took {readTimer.Elapsed} at {count} rows.");
        Assert.True(writeTimer.Elapsed < TimeSpan.FromSeconds(2), $"Warm item upsert took {writeTimer.Elapsed} at {count} rows.");
        Assert.True(readAllocated < 5 * 1024 * 1024, $"Warm item read allocated {readAllocated} bytes at {count} rows.");
        Assert.True(writeAllocated < 5 * 1024 * 1024, $"Warm item upsert allocated {writeAllocated} bytes at {count} rows.");
        Assert.True(bytesWritten > 0, $"Warm update did not produce observable WAL bytes at {count} rows.");
        Assert.True(bytesWritten < 1024 * 1024, $"Warm update grew the WAL by {bytesWritten} bytes at {count} rows.");
        _output.WriteLine(
            $"rows={count} readMs={readTimer.Elapsed.TotalMilliseconds:F3} readAllocated={readAllocated} "
            + $"writeMs={writeTimer.Elapsed.TotalMilliseconds:F3} writeAllocated={writeAllocated} walGrowth={bytesWritten}");
    }

    private UserConfigurationManager Manager()
        => new(new StubAppPaths(_baseDir), NullLogger<UserConfigurationManager>.Instance);

    private void SeedLegacy(AllReviewsStore store)
    {
        Directory.CreateDirectory(ConfigDir);
        File.WriteAllText(
            Path.Combine(ConfigDir, "reviews.json"),
            JsonSerializer.Serialize(store, PersistedJson.WriteOptions));
    }

    private static AllReviewsStore CreateLegacyReviews(int count, Func<int, string> userForIndex)
    {
        var store = new AllReviewsStore();
        for (var index = 0; index < count; index++)
        {
            var user = userForIndex(index);
            var target = (index + 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
            store.Reviews[user + ":movie:" + target] = Review(user, "movie", target, "content", "2025-01-01T00:00:00Z");
        }

        return store;
    }

    private static UserReview Review(string user, string mediaType, string target, string content, string updatedAt)
        => new()
        {
            UserId = user,
            MediaType = mediaType,
            TmdbId = target,
            Content = content,
            Rating = 4,
            CreatedAt = "2024-01-01T00:00:00Z",
            UpdatedAt = updatedAt
        };

    private static string UserId(int value)
        => value.ToString("x32", System.Globalization.CultureInfo.InvariantCulture);

    private static List<UserReview> ReadAllPages(Func<string?, ReviewPage> fetch)
    {
        var reviews = new List<UserReview>();
        string? cursor = null;
        do
        {
            var page = fetch(cursor);
            Assert.InRange(page.Reviews.Count, 0, ReviewLimits.MaximumPageSize);
            reviews.AddRange(page.Reviews);
            cursor = page.NextCursor;
        }
        while (cursor != null);

        return reviews;
    }
}
