using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Model;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Querying;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class LanguageTagInventoryServiceTests
{
    [Fact]
    public void Get_IsCallerScopedCanonicalBoundedAndCachedWithoutTopology()
    {
        var directory = TempDirectory();
        try
        {
            var user = NewUser("inventory");
            var saved = DateTime.UtcNow;
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = saved };
            var queries = 0;
            var library = new CountingLibraryManager
            {
                GetItemsResultHook = query =>
                {
                    queries++;
                    Assert.Same(user, query.User);
                    Assert.Equal(LanguageTagInventoryService.MaximumItemsToScan + 1, query.Limit);
                    return new QueryResult<BaseItem>(0, 1, new BaseItem[] { movie });
                },
            };
            using var cache = new TagCacheService(library, new StubAppPaths(directory), NullLogger<TagCacheService>.Instance);
            cache.SeedEntryForTest(movie.Id.ToString("N"), new TagCacheEntry
            {
                Type = "Movie",
                SourceRevision = saved.Ticks,
                AudioLanguages = new[] { "por-br", "eng", "pt-BR", "und" },
            });
            var service = new LanguageTagInventoryService(library, cache);

            var first = service.Get(user);
            var second = service.Get(user);

            Assert.Equal(new[] { "en", "pt-BR" }, first.Languages);
            Assert.True(first.Complete);
            Assert.False(first.Truncated);
            Assert.Same(first, second);
            Assert.Equal(1, queries);
            Assert.Equal(1, service.CacheCount);
            Assert.Equal(new[] { "Languages", "Complete", "Truncated" },
                typeof(LanguageTagInventory).GetProperties().Select(static property => property.Name));
        }
        finally { TryDelete(directory); }
    }

    [Fact]
    public void Get_PrivacyProjectionIsFailClosedAndNeverCached()
    {
        var directory = TempDirectory();
        try
        {
            var user = NewUser("private");
            var saved = DateTime.UtcNow;
            var movie = new StubMovie { Id = Guid.NewGuid(), DateLastSaved = saved };
            var queries = 0;
            var library = new CountingLibraryManager
            {
                GetItemsResultHook = _ =>
                {
                    queries++;
                    return new QueryResult<BaseItem>(0, 1, new BaseItem[] { movie });
                },
            };
            using var cache = new TagCacheService(library, new StubAppPaths(directory), NullLogger<TagCacheService>.Instance);
            cache.SeedEntryForTest(movie.Id.ToString("N"), new TagCacheEntry
            {
                Type = "Movie", SourceRevision = saved.Ticks, AudioLanguages = new[] { "ja" }, OriginalLanguage = "ja",
            });
            var service = new LanguageTagInventoryService(library, cache);
            Action<Dictionary<string, TagCacheEntry>> strip = entries =>
            {
                foreach (var entry in entries.Values)
                {
                    entry.AudioLanguages = null;
                    entry.OriginalLanguage = null;
                }
            };

            Assert.Empty(service.Get(user, strip).Languages);
            Assert.Empty(service.Get(user, strip).Languages);
            Assert.Equal(new[] { "ja" }, cache.GetEntryForTest(movie.Id.ToString("N"))!.AudioLanguages);
            Assert.Equal("ja", cache.GetEntryForTest(movie.Id.ToString("N"))!.OriginalLanguage);
            Assert.Equal(2, queries);
            Assert.Equal(0, service.CacheCount);
        }
        finally { TryDelete(directory); }
    }

    [Fact]
    public void Get_OversizedOrStaleInventoryFailsClosed()
    {
        var directory = TempDirectory();
        try
        {
            var user = NewUser("bounded");
            var library = new CountingLibraryManager
            {
                GetItemsResultHook = _ => new QueryResult<BaseItem>(
                    0,
                    LanguageTagInventoryService.MaximumItemsToScan + 2,
                    Enumerable.Repeat<BaseItem>(new StubMovie { Id = Guid.NewGuid() }, LanguageTagInventoryService.MaximumItemsToScan + 2).ToArray()),
            };
            using var cache = new TagCacheService(library, new StubAppPaths(directory), NullLogger<TagCacheService>.Instance);
            var result = new LanguageTagInventoryService(library, cache).Get(user);
            Assert.Empty(result.Languages);
            Assert.False(result.Complete);
            Assert.True(result.Truncated);
        }
        finally { TryDelete(directory); }
    }

    private static Jellyfin.Database.Implementations.Entities.User NewUser(string name)
        => new(name, "provider", "password-provider") { Id = Guid.NewGuid() };

    private static string TempDirectory()
    {
        var directory = Path.Combine(Path.GetTempPath(), "jc-language-inventory-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void TryDelete(string directory)
    {
        try { Directory.Delete(directory, recursive: true); } catch { }
    }
}
