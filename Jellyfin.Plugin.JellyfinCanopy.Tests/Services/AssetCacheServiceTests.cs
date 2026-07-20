using System.Net;
using System.Text;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    /// <summary>
    /// Pins the safety properties of the third-party asset cache: manifest allowlist integrity,
    /// path-traversal rejection, CSS url(...) rewriting, size-cap enforcement and last-good
    /// retention. Uses the shared fake <see cref="RecordingHttpMessageHandler"/> — no network.
    /// </summary>
    public sealed class AssetCacheServiceTests : IDisposable
    {
        private readonly string _cacheDir;

        public AssetCacheServiceTests()
        {
            _cacheDir = Path.Combine(Path.GetTempPath(), "jc-asset-cache-tests-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_cacheDir);
        }

        public void Dispose()
        {
            try
            {
                Directory.Delete(_cacheDir, recursive: true);
            }
            catch (IOException)
            {
                // Best-effort temp cleanup.
            }
        }

        private AssetCacheService CreateService(
            HttpMessageHandler handler,
            TimeProvider? timeProvider = null,
            int maxConcurrentFetches = 8,
            ILogger<AssetCacheService>? logger = null)
            => new(
                new RecordingHttpClientFactory(handler),
                logger ?? NullLogger<AssetCacheService>.Instance,
                _cacheDir,
                timeProvider,
                maxConcurrentFetches);

        // ---- Manifest integrity ------------------------------------------------------------

        [Fact]
        public void Manifest_EveryStaticUpstreamHost_IsAllowlisted()
        {
            foreach (var asset in AssetCacheManifest.StaticAssets)
            {
                var uri = new Uri(asset.UpstreamUrl);
                Assert.Equal("https", uri.Scheme);
                Assert.Contains(uri.Host, AssetCacheManifest.AllowedUpstreamHosts, StringComparer.OrdinalIgnoreCase);
            }
        }

        [Fact]
        public void Manifest_EveryFamilyUpstreamHost_IsAllowlisted()
        {
            foreach (var family in AssetCacheManifest.Families)
            {
                var uri = new Uri(string.Format(System.Globalization.CultureInfo.InvariantCulture, family.UrlTemplate, "us"));
                Assert.Equal("https", uri.Scheme);
                Assert.Contains(uri.Host, AssetCacheManifest.AllowedUpstreamHosts, StringComparer.OrdinalIgnoreCase);
            }
        }

        [Fact]
        public void Manifest_EveryDerivedPrefix_IsHttpsOnAnAllowlistedHost()
        {
            foreach (var asset in AssetCacheManifest.StaticAssets.Where(a => a.Rewrite))
            {
                Assert.NotNull(asset.AllowedDerivedPrefixes);
                Assert.NotEmpty(asset.AllowedDerivedPrefixes!);
                foreach (var prefix in asset.AllowedDerivedPrefixes!)
                {
                    var uri = new Uri(prefix);
                    Assert.Equal("https", uri.Scheme);
                    Assert.Contains(uri.Host, AssetCacheManifest.AllowedUpstreamHosts, StringComparer.OrdinalIgnoreCase);
                    // Repo-scoped, never host-wide: the prefix must carry a path.
                    Assert.True(uri.AbsolutePath.Length > 1, $"derived prefix must be path-scoped: {prefix}");
                }
            }
        }

        [Fact]
        public void Manifest_Keys_AreUniqueAndRelative()
        {
            var keys = AssetCacheManifest.StaticAssets.Select(a => a.Key)
                .Concat(AssetCacheManifest.EmbeddedAssets.Select(e => e.Key))
                .ToList();

            Assert.Equal(keys.Count, keys.Distinct(StringComparer.Ordinal).Count());
            foreach (var key in keys)
            {
                Assert.False(key.StartsWith('/'), $"key must be relative: {key}");
                Assert.DoesNotContain("..", key, StringComparison.Ordinal);
                Assert.DoesNotContain('\\', key);
            }
        }

        // ---- Key resolution / traversal guard ------------------------------------------------

        [Theory]
        [InlineData("icons/seerr.svg", AssetKind.Static)]
        [InlineData("fonts/material-symbols-rounded.woff2", AssetKind.Static)]
        [InlineData("themes/ocean.css", AssetKind.Static)]
        [InlineData("flags/4x3/us.svg", AssetKind.Family)]
        [InlineData("flags/w20/de.png", AssetKind.Family)]
        [InlineData("seerr/poster-fallback.svg", AssetKind.Embedded)]
        public void Resolve_ClassifiesKnownKeys(string key, AssetKind expected)
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            Assert.Equal(expected, service.Resolve(key).Kind);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("../secret")]
        [InlineData("icons/../../../etc/passwd")]
        [InlineData("/etc/passwd")]
        [InlineData("icons\\seerr.svg")]
        [InlineData("icons//seerr.svg")]
        [InlineData(".hidden/file")]
        [InlineData("icons/.hidden")]
        [InlineData("flags/4x3/US.svg")]
        [InlineData("flags/4x3/usa.svg")]
        [InlineData("flags/4x3/u.svg")]
        [InlineData("flags/w20/no.svg")]
        [InlineData("derived-map.json")]
        [InlineData("icons/seerr.svg.meta.json")]
        [InlineData("nonexistent/asset.png")]
        public void Resolve_RejectsUnknownAndHostileKeys(string? key)
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            Assert.Equal(AssetKind.Unknown, service.Resolve(key).Kind);
        }

        [Theory]
        [InlineData("../outside")]
        [InlineData("a/../../outside")]
        [InlineData("..")]
        public void TryGetSafeCachePath_RejectsTraversal(string key)
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            Assert.False(service.TryGetSafeCachePath(key, out _));
        }

        [Fact]
        public void TryGetSafeCachePath_AcceptsManifestKey_UnderCacheDir()
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            Assert.True(service.TryGetSafeCachePath("icons/seerr.svg", out var path));
            Assert.StartsWith(Path.GetFullPath(_cacheDir) + Path.DirectorySeparatorChar, path, StringComparison.Ordinal);
        }

        // ---- CSS rewriting -------------------------------------------------------------------

        private static ResolvedAsset RewriteEntry(string key, string upstream, params string[] prefixes)
            => new(AssetKind.Static, key, upstream, "text/css", 1024 * 1024, Rewrite: true, AllowedDerivedPrefixes: prefixes);

        [Fact]
        public void RewriteCss_RewritesAllowedAbsoluteUrls_ToRelativeDerivedRefs()
        {
            var entry = RewriteEntry(
                "metadata-icons/public-icon.css",
                "https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css",
                "https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata",
                "https://raw.githubusercontent.com/Druidblack/jellyfin-icon-metadata/");

            var css = ".a { background: url('https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata@main/icons/imdb/imdb.png'); }\n"
                + ".b { background: url(https://raw.githubusercontent.com/Druidblack/jellyfin-icon-metadata/refs/heads/main/icons/shoko/shoko-file.png); }";

            var (rewritten, derived) = AssetCacheService.RewriteCss(css, entry);

            Assert.Equal(2, derived.Count);
            Assert.All(derived, d => Assert.StartsWith("metadata-icons/d/", d.Key, StringComparison.Ordinal));
            Assert.All(derived, d => Assert.EndsWith(".png", d.Key, StringComparison.Ordinal));
            Assert.All(derived, d => Assert.Equal("image/png", d.ContentType));
            // References become RELATIVE (resolve against the CSS's own URL, so reverse-proxy
            // sub-paths keep working) and quoting style is preserved.
            Assert.Contains("url('d/", rewritten, StringComparison.Ordinal);
            Assert.Contains("url(d/", rewritten, StringComparison.Ordinal);
            Assert.DoesNotContain("cdn.jsdelivr.net", rewritten, StringComparison.Ordinal);
            Assert.DoesNotContain("raw.githubusercontent.com", rewritten, StringComparison.Ordinal);
        }

        [Fact]
        public void RewriteCss_LeavesDisallowedUrls_DataUris_AndFragments()
        {
            var entry = RewriteEntry(
                "metadata-icons/public-icon.css",
                "https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/public-icon.css",
                "https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata");

            var css = ".evil { background: url(https://evil.example.com/x.png); }\n"
                + ".otherRepo { background: url(https://cdn.jsdelivr.net/gh/someone/else/x.png); }\n"
                + ".http { background: url(http://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata/x.png); }\n"
                + ".data { background: url(data:image/png;base64,AAAA); }\n"
                + ".frag { fill: url(#gradient); }";

            var (rewritten, derived) = AssetCacheService.RewriteCss(css, entry);

            Assert.Empty(derived);
            Assert.Equal(css, rewritten);
        }

        [Fact]
        public void RewriteCss_ResolvesRelativeReferences_AgainstUpstreamUrl()
        {
            var entry = RewriteEntry(
                "themes/ocean.css",
                "https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/ocean.css",
                "https://cdn.jsdelivr.net/gh/n00bcodr/jellyfish");

            var (rewritten, derived) = AssetCacheService.RewriteCss(
                ":root { --background-image: url(\"images/ocean.jpg\"); }", entry);

            var d = Assert.Single(derived);
            Assert.Equal("https://cdn.jsdelivr.net/gh/n00bcodr/Jellyfish/colors/images/ocean.jpg", d.Url);
            Assert.StartsWith("themes/d/", d.Key, StringComparison.Ordinal);
            Assert.EndsWith(".jpg", d.Key, StringComparison.Ordinal);
            Assert.Contains("url(\"d/", rewritten, StringComparison.Ordinal);
        }

        [Fact]
        public void RewriteCss_DerivedKeys_AreStableAndDeduplicated()
        {
            var entry = RewriteEntry(
                "fonts/material-symbols-outlined.css",
                "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined",
                "https://fonts.gstatic.com/s/materialsymbolsoutlined/");

            var css = "@font-face { src: url(https://fonts.gstatic.com/s/materialsymbolsoutlined/v355/a.woff2) format('woff2'); }\n"
                + "@font-face { src: url(https://fonts.gstatic.com/s/materialsymbolsoutlined/v355/a.woff2) format('woff2'); }";

            var (_, first) = AssetCacheService.RewriteCss(css, entry);
            var (_, second) = AssetCacheService.RewriteCss(css, entry);

            var derived = Assert.Single(first); // Same URL twice → one derived asset.
            Assert.Equal("font/woff2", derived.ContentType);
            Assert.Equal(derived.Key, Assert.Single(second).Key); // Deterministic across runs.
        }

        // ---- Fetch behavior (fake handler, no network) -----------------------------------------

        [Fact]
        public async Task EnsureCached_FetchesAndServesFromDisk()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/gh/selfhst/icons/svg/seerr.svg", "<svg>seerr</svg>");
            var service = CreateService(handler);

            var path = await service.EnsureCachedAsync(service.Resolve("icons/seerr.svg"), forceRefresh: false, CancellationToken.None);

            Assert.NotNull(path);
            Assert.Equal("<svg>seerr</svg>", await File.ReadAllTextAsync(path!));

            // Second call must not re-fetch: it serves the cached copy.
            var requestsBefore = handler.Requests.Count;
            var again = await service.EnsureCachedAsync(service.Resolve("icons/seerr.svg"), forceRefresh: false, CancellationToken.None);
            Assert.Equal(path, again);
            Assert.Equal(requestsBefore, handler.Requests.Count);
        }

        [Fact]
        public async Task EnsureCached_EnforcesSizeCap_AndKeepsLastGood()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/resources/regions.txt", "US\tUnited States");
            var service = CreateService(handler);

            var resolved = service.Resolve("elsewhere/regions.txt");
            var path = await service.EnsureCachedAsync(resolved, forceRefresh: false, CancellationToken.None);
            Assert.NotNull(path);

            // Upstream now serves a body over the 256 KB text cap: the refresh must reject it
            // and keep the last good copy on disk.
            handler.AddResponse("/resources/regions.txt", new string('x', 300 * 1024));
            var refreshed = await service.EnsureCachedAsync(resolved, forceRefresh: true, CancellationToken.None);

            Assert.Equal(path, refreshed);
            Assert.Equal("US\tUnited States", await File.ReadAllTextAsync(path!));
        }

        [Fact]
        public async Task EnsureCached_UpstreamFailure_KeepsLastGood()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/resources/providers.txt", "Netflix");
            var service = CreateService(handler);

            var resolved = service.Resolve("elsewhere/providers.txt");
            var path = await service.EnsureCachedAsync(resolved, forceRefresh: false, CancellationToken.None);
            Assert.NotNull(path);

            handler.AddResponse("/resources/providers.txt", "boom", HttpStatusCode.InternalServerError);
            var refreshed = await service.EnsureCachedAsync(resolved, forceRefresh: true, CancellationToken.None);

            Assert.Equal(path, refreshed);
            Assert.Equal("Netflix", await File.ReadAllTextAsync(path!));
        }

        [Fact]
        public async Task EnsureCached_UnknownOrEmbedded_NeverFetches()
        {
            var handler = new RecordingHttpMessageHandler();
            var service = CreateService(handler);

            Assert.Null(await service.EnsureCachedAsync(service.Resolve("../evil"), forceRefresh: false, CancellationToken.None));
            Assert.Null(await service.EnsureCachedAsync(service.Resolve("seerr/poster-fallback.svg"), forceRefresh: false, CancellationToken.None));
            Assert.Empty(handler.Requests);
        }

        [Fact]
        public async Task EnsureCached_RewriteEntry_StoresRewrittenCss_AndRegistersDerived()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse(
                "/gh/Druidblack/jellyfin-icon-metadata/public-icon.css",
                ".x { background: url('https://cdn.jsdelivr.net/gh/Druidblack/jellyfin-icon-metadata@main/icons/imdb/imdb.png'); }");
            handler.AddResponse("/gh/Druidblack/jellyfin-icon-metadata@main/icons/imdb/imdb.png", "PNG");
            var service = CreateService(handler);

            var cssPath = await service.EnsureCachedAsync(service.Resolve("metadata-icons/public-icon.css"), forceRefresh: false, CancellationToken.None);
            Assert.NotNull(cssPath);

            var stored = await File.ReadAllTextAsync(cssPath!);
            Assert.DoesNotContain("https://", stored, StringComparison.Ordinal);
            Assert.Contains("url('d/", stored, StringComparison.Ordinal);

            // The derived key parsed back out of the rewritten CSS resolves and fetches.
            var relative = System.Text.RegularExpressions.Regex.Match(stored, @"url\('(d/[^']+)'\)").Groups[1].Value;
            var derivedResolved = service.Resolve("metadata-icons/" + relative);
            Assert.Equal(AssetKind.Derived, derivedResolved.Kind);

            var derivedPath = await service.EnsureCachedAsync(derivedResolved, forceRefresh: false, CancellationToken.None);
            Assert.NotNull(derivedPath);
            Assert.Equal("PNG", await File.ReadAllTextAsync(derivedPath!));
        }

        [Fact]
        public async Task EnsureCached_SendsConditionalGet_WhenRefreshingExistingFile()
        {
            var handler = new RecordingHttpMessageHandler();
            handler.AddResponse("/gh/selfhst/icons/svg/sonarr.svg", "<svg>sonarr</svg>");
            var service = CreateService(handler);

            var resolved = service.Resolve("icons/sonarr.svg");
            var path = await service.EnsureCachedAsync(resolved, forceRefresh: false, CancellationToken.None);
            Assert.NotNull(path);

            // Simulate a stored validator, as a real 200 with an ETag header would produce.
            await File.WriteAllTextAsync(
                path + ".meta.json",
                "{\"ETag\":\"\\\"v1\\\"\",\"LastModified\":null,\"FetchedUtc\":\"2026-01-01T00:00:00+00:00\"}");

            await service.EnsureCachedAsync(resolved, forceRefresh: true, CancellationToken.None);

            var refreshRequest = handler.Requests[^1];
            Assert.Contains("\"v1\"", refreshRequest.Headers.IfNoneMatch.ToString(), StringComparison.Ordinal);
        }

        [Fact]
        public async Task RefreshAll_OneFailingAsset_DoesNotAbortTheRest()
        {
            var handler = new RecordingHttpMessageHandler();
            // Only two upstreams answer; every other manifest asset 404s (the handler's default).
            handler.AddResponse("/resources/regions.txt", "US\tUnited States");
            handler.AddResponse("/resources/providers.txt", "Netflix");
            var service = CreateService(handler);

            var summary = await service.RefreshAllAsync(progress: null, CancellationToken.None);

            Assert.Equal(2, summary.Succeeded);
            Assert.True(summary.Failed > 0);
            Assert.Equal(summary.Attempted, summary.Succeeded + summary.NotModified + summary.Failed);
            Assert.True(File.Exists(Path.Combine(_cacheDir, "elsewhere", "regions.txt")));
        }

        [Fact]
        public async Task EnsureCached_OneHundredSameKeyFailures_FetchOncePerBackoffWindow()
        {
            var handler = new RecordingHttpMessageHandler();
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 15, 0, 0, 0, TimeSpan.Zero));
            var logger = new CapturingLogger<AssetCacheService>();
            var service = CreateService(handler, clock, logger: logger);
            var asset = service.Resolve("icons/seerr.svg");

            var firstWindow = await Task.WhenAll(Enumerable.Range(0, 100)
                .Select(_ => service.EnsureCachedAsync(asset, forceRefresh: false, CancellationToken.None)));

            Assert.All(firstWindow, Assert.Null);
            Assert.Single(handler.Requests);
            Assert.Single(logger.WarningMessages);
            Assert.Equal(1, service.FailureStateCount);

            clock.Advance(TimeSpan.FromSeconds(29));
            await Task.WhenAll(Enumerable.Range(0, 100)
                .Select(_ => service.EnsureCachedAsync(asset, forceRefresh: false, CancellationToken.None)));
            Assert.Single(handler.Requests);
            Assert.Single(logger.WarningMessages);

            // At expiry, exactly one caller becomes the retry leader. Its failure opens the next
            // (one-minute) window before any of the remaining 99 waiters may fetch.
            clock.Advance(TimeSpan.FromSeconds(1));
            await Task.WhenAll(Enumerable.Range(0, 100)
                .Select(_ => service.EnsureCachedAsync(asset, forceRefresh: false, CancellationToken.None)));
            Assert.Equal(2, handler.Requests.Count);
            Assert.Equal(2, logger.WarningMessages.Count);
        }

        [Fact]
        public async Task EnsureCached_DifferentKeys_NeverExceedGlobalFetchLimit()
        {
            const int limit = 3;
            var handler = new BlockingFailureHandler(limit);
            var service = CreateService(handler, maxConcurrentFetches: limit);
            var tasks = Enumerable.Range(0, 20)
                .Select(i =>
                {
                    var first = (char)('a' + (i / 26));
                    var second = (char)('a' + (i % 26));
                    return service.EnsureCachedAsync(
                        service.Resolve($"flags/4x3/{first}{second}.svg"),
                        forceRefresh: false,
                        CancellationToken.None);
                })
                .ToArray();

            var reached = await Task.WhenAny(handler.ReachedLimit, Task.Delay(TimeSpan.FromSeconds(5)));
            Assert.Same(handler.ReachedLimit, reached);
            Assert.Equal(limit, handler.PeakActive);

            handler.Release();
            await Task.WhenAll(tasks);

            Assert.Equal(20, handler.Calls);
            Assert.Equal(limit, handler.PeakActive);
        }

        [Fact]
        public async Task EnsureCached_SuccessfulRecovery_ClearsNegativeStateOnce()
        {
            var handler = new RecordingHttpMessageHandler();
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 7, 15, 0, 0, 0, TimeSpan.Zero));
            var logger = new CapturingLogger<AssetCacheService>();
            var service = CreateService(handler, clock, logger: logger);
            var asset = service.Resolve("elsewhere/providers.txt");

            Assert.Null(await service.EnsureCachedAsync(asset, forceRefresh: false, CancellationToken.None));
            Assert.Equal(1, service.FailureStateCount);

            handler.AddResponse("/resources/providers.txt", "Netflix");
            clock.Advance(TimeSpan.FromSeconds(30));
            var recovered = await service.EnsureCachedAsync(asset, forceRefresh: false, CancellationToken.None);

            Assert.NotNull(recovered);
            Assert.Equal("Netflix", await File.ReadAllTextAsync(recovered!));
            Assert.Equal(0, service.FailureStateCount);
            Assert.Single(logger.InformationMessages);

            // A normal cache hit neither contacts upstream nor repeats the recovery transition.
            var requests = handler.Requests.Count;
            Assert.Equal(recovered, await service.EnsureCachedAsync(asset, forceRefresh: false, CancellationToken.None));
            Assert.Equal(requests, handler.Requests.Count);
            Assert.Single(logger.InformationMessages);
        }

        // ---- Embedded assets --------------------------------------------------------------------

        [Fact]
        public void OpenEmbeddedAsset_PosterFallback_IsPresentInAssembly()
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            var resolved = service.Resolve("seerr/poster-fallback.svg");

            using var stream = AssetCacheService.OpenEmbeddedAsset(resolved);

            Assert.NotNull(stream);
            using var reader = new StreamReader(stream!, Encoding.UTF8);
            var svg = reader.ReadToEnd();
            Assert.Contains("<svg", svg, StringComparison.Ordinal);
            // The guaranteed placeholder must not itself depend on the network.
            Assert.DoesNotContain("http", svg.Replace("http://www.w3.org", string.Empty, StringComparison.Ordinal), StringComparison.Ordinal);
        }

        [Fact]
        public void OpenEmbeddedAsset_ThemeOperationalStylesheet_IsPresentAndLocallyScoped()
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            var resolved = service.Resolve("theme-studio/operational-surfaces.css");

            using var stream = AssetCacheService.OpenEmbeddedAsset(resolved);

            Assert.NotNull(stream);
            using var reader = new StreamReader(stream!, Encoding.UTF8);
            var css = reader.ReadToEnd();
            Assert.Contains(":root.jc-modern-layout", css, StringComparison.Ordinal);
            Assert.Contains("[data-jc-theme-breakpoint=\"phone\"]", css, StringComparison.Ordinal);
            Assert.Contains("[data-jc-theme-breakpoint=\"desktop\"]", css, StringComparison.Ordinal);
            Assert.DoesNotContain("url(", css, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("@import", css, StringComparison.OrdinalIgnoreCase);
        }

        [Theory]
        [InlineData("theme-studio/seerr-surfaces.css", "seerr-discovery-v1")]
        [InlineData("theme-studio/arr-surfaces.css", "arr-release-operations-v1")]
        [InlineData("theme-studio/external-surfaces.css", "reviews-availability-links-v1")]
        public void OpenEmbeddedAsset_ThemeIntegrationStylesheets_ArePresentAndLocallyScoped(
            string key,
            string adapter)
        {
            var service = CreateService(new RecordingHttpMessageHandler());
            var resolved = service.Resolve(key);

            using var stream = AssetCacheService.OpenEmbeddedAsset(resolved);

            Assert.NotNull(stream);
            using var reader = new StreamReader(stream!, Encoding.UTF8);
            var css = reader.ReadToEnd();
            Assert.Contains(adapter, css, StringComparison.Ordinal);
            Assert.Contains(":root.jc-modern-layout", css, StringComparison.Ordinal);
            Assert.Contains("[data-jc-theme-breakpoint=\"phone\"]", css, StringComparison.Ordinal);
            Assert.Contains("[data-jc-theme-breakpoint=\"desktop\"]", css, StringComparison.Ordinal);
            Assert.DoesNotContain("url(", css, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("@import", css, StringComparison.OrdinalIgnoreCase);
        }

        private sealed class ManualTimeProvider : TimeProvider
        {
            private DateTimeOffset _now;

            public ManualTimeProvider(DateTimeOffset now) => _now = now;

            public override DateTimeOffset GetUtcNow() => _now;

            public void Advance(TimeSpan amount) => _now = _now.Add(amount);
        }

        private sealed class BlockingFailureHandler : HttpMessageHandler
        {
            private readonly int _expectedLimit;
            private readonly TaskCompletionSource _reachedLimit = new(TaskCreationOptions.RunContinuationsAsynchronously);
            private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
            private int _active;
            private int _calls;
            private int _peakActive;

            public BlockingFailureHandler(int expectedLimit) => _expectedLimit = expectedLimit;

            public Task ReachedLimit => _reachedLimit.Task;

            public int Calls => Volatile.Read(ref _calls);

            public int PeakActive => Volatile.Read(ref _peakActive);

            public void Release() => _release.TrySetResult();

            protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref _calls);
                var active = Interlocked.Increment(ref _active);
                UpdatePeak(active);
                if (active >= _expectedLimit)
                {
                    _reachedLimit.TrySetResult();
                }

                try
                {
                    await _release.Task.WaitAsync(cancellationToken);
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                    {
                        Content = new StringContent("unavailable"),
                    };
                }
                finally
                {
                    Interlocked.Decrement(ref _active);
                }
            }

            private void UpdatePeak(int candidate)
            {
                while (true)
                {
                    var current = Volatile.Read(ref _peakActive);
                    if (candidate <= current || Interlocked.CompareExchange(ref _peakActive, candidate, current) == current)
                    {
                        return;
                    }
                }
            }
        }

        private sealed class CapturingLogger<T> : ILogger<T>
        {
            public List<string> WarningMessages { get; } = new();

            public List<string> InformationMessages { get; } = new();

            public IDisposable? BeginScope<TState>(TState state)
                where TState : notnull
                => null;

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                var message = formatter(state, exception);
                if (logLevel == LogLevel.Warning)
                {
                    WarningMessages.Add(message);
                }
                else if (logLevel == LogLevel.Information)
                {
                    InformationMessages.Add(message);
                }
            }
        }
    }
}
