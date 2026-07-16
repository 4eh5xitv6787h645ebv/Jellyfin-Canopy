using System.Security.Claims;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Logging;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Services.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Entities.Movies;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class HiddenContentPayloadControllerTests : IDisposable
{
    private readonly string _baseDir;
    private readonly UserConfigurationManager _manager;
    private readonly User _user;
    private readonly FakePluginConfigProvider _provider;

    public HiddenContentPayloadControllerTests()
    {
        _baseDir = Path.Combine(Path.GetTempPath(), "jc-hidden-payload-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_baseDir);
        _manager = new UserConfigurationManager(
            new StubAppPaths(_baseDir),
            NullLogger<UserConfigurationManager>.Instance);
        _user = new User("hidden-user", "Provider", "PasswordProvider");
        _provider = new FakePluginConfigProvider(new PluginConfiguration());
    }

    private string UserId => _user.Id.ToString("N");

    private string HiddenPath => Path.Combine(
        _baseDir,
        "configurations",
        "Jellyfin.Plugin.JellyfinCanopy",
        UserId,
        "hidden-content.json");

    public void Dispose()
    {
        HiddenContentResponseFilter.InvalidateUser(UserId);
        try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public void RejectedPayload_LeavesDiskAndCacheUnchanged()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["old"] = new HiddenContentItem { Name = "old-value", HideScope = "global" }
            }
        });
        var before = File.ReadAllBytes(HiddenPath);
        HiddenContentResponseFilter.SeedCacheForTest(UserId);

        var candidate = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["new"] = new HiddenContentItem
                {
                    Name = new string('x', 513),
                    PosterPath = "API_KEY_SHOULD_NEVER_BE_LOGGED"
                }
            }
        };
        var result = Controller(NullLogger<HiddenContentController>.Instance)
            .SaveUserHiddenContent(UserId, candidate);

        var rejected = Assert.IsType<BadRequestObjectResult>(result);
        var response = Assert.IsType<PersistedPayloadErrorResponse>(rejected.Value);
        Assert.Equal("invalid_hidden_item", response.Code);
        Assert.Equal(before, File.ReadAllBytes(HiddenPath));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(UserId));
    }

    [Fact]
    public void NormalizationCrossingPersistedCeiling_IsRejectedWithoutDiskOrCacheMutation()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent());
        var before = File.ReadAllBytes(HiddenPath);
        HiddenContentResponseFilter.SeedCacheForTest(UserId);
        var candidate = BuildNormalizationBoundaryPayload();
        Assert.True(PersistedPayloadPolicy.Validate(candidate).IsValid);
        Assert.Equal(
            PersistedPayloadStatus.TooLarge,
            PersistedPayloadPolicy.Validate(PersistedPayloadPolicy.CloneValidated(candidate)).Status);

        var result = Controller(NullLogger<HiddenContentController>.Instance)
            .SaveUserHiddenContent(UserId, candidate);

        var rejected = Assert.IsType<ObjectResult>(result);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, rejected.StatusCode);
        Assert.Equal("payload_too_large", Assert.IsType<PersistedPayloadErrorResponse>(rejected.Value).Code);
        Assert.Equal(before, File.ReadAllBytes(HiddenPath));
        Assert.True(HiddenContentResponseFilter.IsCachedForTest(UserId));
    }

    [Fact]
    public async Task AcceptedPayload_LogsMetadataOnlyToHostAndDedicatedSinks()
    {
        const string secret = "api-key-SUPER-SECRET-sentinel";
        var hostProvider = new CapturingLoggerProvider();
        using var hostFactory = LoggerFactory.Create(builder =>
        {
            builder.SetMinimumLevel(LogLevel.Trace);
            builder.AddProvider(hostProvider);
        });
        using var fileProvider = new JellyfinCanopyFileLoggerProvider(new StubAppPaths(_baseDir));
        var logger = new FileForwardingLogger<HiddenContentController>(fileProvider, hostFactory);
        var candidate = new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["safe-key"] = new HiddenContentItem
                {
                    Name = secret,
                    PosterPath = "/poster/" + secret,
                    HideScope = "series"
                }
            }
        };

        var result = Controller(logger).SaveUserHiddenContent(UserId, candidate);
        Assert.True(await fileProvider.FlushAsync(TimeSpan.FromSeconds(5)));

        Assert.IsType<OkObjectResult>(result);
        Assert.Equal(secret, candidate.Items["safe-key"].Name);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(secret, stored.Items["safe-key"].Name);
        var hostText = string.Join('\n', hostProvider.Messages);
        var fileText = File.ReadAllText(fileProvider.CurrentLogFilePath);
        Assert.DoesNotContain(secret, hostText, StringComparison.Ordinal);
        Assert.DoesNotContain(secret, fileText, StringComparison.Ordinal);
        Assert.Contains("items=1", hostText, StringComparison.Ordinal);
        Assert.Contains("items=1", fileText, StringComparison.Ordinal);
    }

    [Fact]
    public void AdminHide_UsesTypedProviderKeysAndNeverCreatesAnAmbiguousBareTmdbRow()
    {
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                ["tmdb-549"] = new() { Name = "Legacy movie", Type = "Movie", TmdbId = "549" }
            }
        });
        var controller = Controller(NullLogger<HiddenContentController>.Instance);
        var result = controller.AdminHideForUser(UserId, new List<HiddenContentItem>
        {
            new() { Name = "Legacy movie", Type = "Movie", TmdbId = "549" },
            new() { Name = "Movie 550", Type = "Movie", TmdbId = "550" },
            new() { Name = "TV 550", Type = "Series", TmdbId = "550" },
            new() { Name = "Ambiguous 551", TmdbId = "551" },
            new() { ItemId = "jf-exact", Name = "Local", TmdbId = "552" }
        });

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(4, stored.Items.Count);
        Assert.True(stored.Items.ContainsKey("tmdb-549"));
        Assert.False(stored.Items.ContainsKey("hc1:tmdb:movie:549"));
        Assert.Equal("movie", stored.Items["hc1:tmdb:movie:550"].Identity?.MediaType);
        Assert.Equal("tv", stored.Items["hc1:tmdb:tv:550"].Identity?.MediaType);
        Assert.True(stored.Items.ContainsKey("jf-exact"));
        Assert.Equal(
            new[] { "tmdb-549" },
            stored.Items.Keys.Where(static key => key.StartsWith("tmdb-", StringComparison.Ordinal)));

        Assert.IsType<OkObjectResult>(controller.AdminUnhideForUser(
            UserId,
            new List<string> { "hc1:tmdb:movie:550" }));
        stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.False(stored.Items.ContainsKey("hc1:tmdb:movie:550"));
        Assert.True(stored.Items.ContainsKey("hc1:tmdb:tv:550"));
    }

    [Fact]
    public void AdminHide_SkipsInvalidExplicitIdentitiesAndPreservesDistinctExactItems()
    {
        var controller = Controller(NullLogger<HiddenContentController>.Instance);
        var result = controller.AdminHideForUser(UserId, new List<HiddenContentItem>
        {
            new()
            {
                ItemId = "jf-1",
                Name = "Edition one",
                Type = "Movie",
                TmdbId = "550",
                Identity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "550"
                }
            },
            new()
            {
                ItemId = "jf-2",
                Name = "Edition two",
                Type = "Movie",
                TmdbId = "550",
                Identity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "550"
                }
            },
            new()
            {
                ItemId = "future",
                Type = "Movie",
                TmdbId = "551",
                Identity = new HiddenContentIdentity
                {
                    Version = 2,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "551"
                }
            },
            new()
            {
                ItemId = "malformed",
                Type = "Movie",
                TmdbId = "552",
                Identity = new HiddenContentIdentity
                {
                    Version = 1,
                    Provider = "tmdb",
                    MediaType = "movie",
                    Id = "not-decimal"
                }
            }
        });

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        Assert.Equal(new[] { "jf-1", "jf-2" }, stored.Items.Keys.Order(StringComparer.Ordinal));
        Assert.All(stored.Items.Values, item =>
        {
            Assert.Equal("550", item.TmdbId);
            Assert.Equal("movie", item.Identity?.MediaType);
        });
    }

    [Fact]
    public void ScopedHide_AtomicallyPrefersAlternateTypedMetadataOverCanonicalLegacyMetadata()
    {
        var itemId = Guid.Parse("11111111-2222-3333-4444-555555555555");
        var dashed = itemId.ToString();
        var compact = itemId.ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [dashed] = new()
                {
                    ItemId = dashed,
                    Name = "Legacy Movie 550",
                    TmdbId = "550",
                    HideScope = "continuewatching"
                },
                [compact] = new()
                {
                    ItemId = compact,
                    Name = "Movie 551",
                    Type = "Movie",
                    TmdbId = "551",
                    Identity = new HiddenContentIdentity
                    {
                        Version = 1,
                        Provider = "tmdb",
                        MediaType = "movie",
                        Id = "551"
                    },
                    HideScope = "nextup"
                }
            }
        });
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Movie 550" }
                : null
        };

        var result = Controller(NullLogger<HiddenContentController>.Instance, library)
            .HideFromContinueWatching(compact);

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        var item = Assert.Single(stored.Items, pair => pair.Key == dashed).Value;
        Assert.Equal(dashed, item.ItemId);
        Assert.Equal("551", item.TmdbId);
        Assert.Equal("movie", item.Identity?.MediaType);
        Assert.Equal("551", item.Identity?.Id);
        Assert.Equal("homesections", item.HideScope);
    }

    [Fact]
    public void ScopedHide_ReconcilesFreshTypedIdentityWithLegacyTmdbMetadata()
    {
        var itemId = Guid.Parse("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        var dashed = itemId.ToString();
        var compact = itemId.ToString("N");
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [compact] = new()
                {
                    ItemId = compact,
                    Name = "Legacy Movie 550",
                    Type = "Movie",
                    TmdbId = "550",
                    HideScope = "continuewatching"
                }
            }
        });
        var movie = new Movie { Id = itemId, Name = "Movie 551" };
        movie.ProviderIds["Tmdb"] = "551";
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId ? movie : null
        };

        var result = Controller(NullLogger<HiddenContentController>.Instance, library)
            .HideFromNextUp(dashed);

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        var item = Assert.Single(stored.Items, pair => pair.Key == dashed).Value;
        Assert.Equal("551", item.TmdbId);
        Assert.Equal("tmdb", item.Identity?.Provider);
        Assert.Equal("movie", item.Identity?.MediaType);
        Assert.Equal("551", item.Identity?.Id);
        Assert.Equal("homesections", item.HideScope);
    }

    [Fact]
    public void ScopedHide_PreservesUnsupportedIdentityAndTmdbAsAnOpaquePair()
    {
        var itemId = Guid.Parse("99999999-8888-7777-6666-555555555555");
        var dashed = itemId.ToString();
        _manager.SaveUserConfiguration(UserId, "hidden-content.json", new UserHiddenContent
        {
            Items = new Dictionary<string, HiddenContentItem>
            {
                [dashed] = new()
                {
                    ItemId = dashed,
                    Name = "Future identity",
                    Type = "Movie",
                    TmdbId = "550",
                    Identity = new HiddenContentIdentity
                    {
                        Version = 2,
                        Provider = "imdb",
                        MediaType = "movie",
                        Id = "tt123"
                    },
                    HideScope = "continuewatching"
                }
            }
        });
        var library = new CountingLibraryManager
        {
            GetItemByIdUserHook = (id, _) => id == itemId
                ? new Movie { Id = itemId, Name = "Future identity" }
                : null
        };

        var result = Controller(NullLogger<HiddenContentController>.Instance, library)
            .HideFromContinueWatching(dashed);

        Assert.IsType<OkObjectResult>(result);
        var stored = _manager.GetUserConfigurationStrict<UserHiddenContent>(UserId, "hidden-content.json");
        var item = Assert.Single(stored.Items).Value;
        Assert.Equal("550", item.TmdbId);
        Assert.Equal(2, item.Identity?.Version);
        Assert.Equal("imdb", item.Identity?.Provider);
        Assert.Equal("tt123", item.Identity?.Id);
    }

    private HiddenContentController Controller(
        ILogger<HiddenContentController> logger,
        CountingLibraryManager? libraryManager = null)
    {
        var controller = new HiddenContentController(
            new RecordingHttpClientFactory(new HttpClientHandler()),
            logger,
            new StubUserManager(_user),
            new SeerrCache(_provider),
            _provider,
            _manager,
            libraryManager ?? new CountingLibraryManager());
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

    private static UserHiddenContent BuildNormalizationBoundaryPayload()
    {
        var payload = new UserHiddenContent();
        for (var i = 0; i < PersistedPayloadPolicy.MaximumHiddenItems; i++)
        {
            payload.Items.Add(i.ToString("x32"), new HiddenContentItem { HideScope = null! });
        }

        // null -> "global" adds exactly four UTF-8 bytes per item. Place the
        // bound graph 20,000 bytes below the ceiling, so only normalization
        // crosses it. ASCII field padding changes serialized size one-for-one.
        var targetBytes = PersistedPayloadPolicy.HiddenContentPersistedBytes - 20_000;
        var baseBytes = PersistedPayloadPolicy.ValidateSerializedSize(payload, int.MaxValue).SerializedBytes;
        var remaining = targetBytes - baseBytes;
        Assert.True(remaining > 0, "boundary fixture base unexpectedly exceeds its target");
        foreach (var item in payload.Items.Values)
        {
            item.Name = Padding(ref remaining, 512);
            item.SeriesName = Padding(ref remaining, 512);
            item.PosterPath = Padding(ref remaining, 512);
            if (remaining == 0)
            {
                break;
            }
        }

        Assert.Equal(0, remaining);
        Assert.Equal(
            targetBytes,
            PersistedPayloadPolicy.ValidateSerializedSize(payload, int.MaxValue).SerializedBytes);
        return payload;
    }

    private static string Padding(ref int remaining, int maximum)
    {
        var length = Math.Min(remaining, maximum);
        remaining -= length;
        return new string('x', length);
    }

    private sealed class CapturingLoggerProvider : ILoggerProvider
    {
        public List<string> Messages { get; } = new();

        public ILogger CreateLogger(string categoryName) => new CapturingLogger(Messages);

        public void Dispose()
        {
        }

        private sealed class CapturingLogger : ILogger
        {
            private readonly List<string> _messages;

            public CapturingLogger(List<string> messages) => _messages = messages;

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
                => _messages.Add(formatter(state, exception));
        }
    }
}
