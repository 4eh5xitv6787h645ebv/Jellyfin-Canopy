using System.Net.Http;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.EventHandlers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.ScheduledTasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using MediaBrowser.Controller;

namespace Jellyfin.Plugin.JellyfinCanopy
{
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<StartupService>();

            // Request-time injection middlewares (Jellyfin 10.11 & 12):
            //   - ScriptInjectionStartupFilter injects the client <script> into the
            //     web index.html;
            //   - BrandingAssetStartupFilter serves custom logo/banner/favicon images.
            //     Both are kill-switchable via config and no-op safely when there's
            //     nothing to do.
            serviceCollection.AddSingleton<IStartupFilter, ScriptInjectionStartupFilter>();
            serviceCollection.AddSingleton<IStartupFilter, BrandingAssetStartupFilter>();

            serviceCollection.AddHttpClient();

            // Platform v1 owns a wire format without changing any legacy controller.
            serviceCollection.Configure<MvcOptions>(options =>
                options.InputFormatters.Insert(0, new PlatformJsonInputFormatter()));
            // The sole process-wide owner of bounded idempotency state. Future mutation
            // endpoints consume this singleton; no current read route changes behavior.
            serviceCollection.AddSingleton<PlatformIdempotencyStore>();
            // One process-local 256-bit authority and nonce ledger for short-lived
            // native action capabilities. Restart intentionally invalidates every token.
            serviceCollection.AddSingleton<PlatformActionCapabilityService>();
            // Server-private prepared preconditions remain process-local and expire no
            // later than their opaque capability. Invocation concurrency is bounded by
            // authoritative actor and the closed operation vocabulary.
            serviceCollection.AddSingleton<PlatformPreparedActionContextOwner>();
            serviceCollection.AddSingleton<PlatformActionAdmissionLimiter>();
            // One process-wide, fixed-capacity owner for redacted terminal Platform
            // action audit. It exposes no route and retains no caller payload.
            serviceCollection.AddSingleton<PlatformAuditStore>();

            // a named HttpClient with AllowAutoRedirect=false so
            // forward-auth proxies (Authelia / Pangolin / Authentik) returning
            // 302 to a login URL are detected as `UpstreamRedirect` instead of
            // silently followed and producing a 200 + login HTML body.
            // SeerrHttpHelper.CreateClient(factory) selects this for outbound
            // Seerr calls. The guarded handler re-validates the connect-time IP
            // (DNS-rebind / TOCTOU defense) on top of the pre-flight URL guard.
            serviceCollection.AddHttpClient(Helpers.Seerr.SeerrHttpHelper.NamedClient)
                .ConfigurePrimaryHttpMessageHandler(() => Helpers.ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: false));

            // Named clients for the remaining upstreams (see PluginHttpClients for
            // the per-upstream rationale). The Arr client points at admin-supplied
            // Sonarr/Radarr URLs, so it routes through the guarded handler (connect-time
            // IP re-check) while keeping AllowAutoRedirect=true. TmdbClient/AssetsClient
            // target hardcoded/allowlisted CDNs and keep the default handler. API keys
            // are attached per-request (HttpRequestMessage), never via DefaultRequestHeaders.
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.ArrClient)
                .ConfigurePrimaryHttpMessageHandler(() => Helpers.ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: true));
            RegisterMaintainerrHttpClient(serviceCollection);
            // Discovery probes server-chosen private-network candidates and is
            // credential-free; suppress default URI logging like Maintainerr's
            // (candidate URLs are private-network topology).
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.DiscoveryClient)
                .RemoveAllLoggers()
                .ConfigurePrimaryHttpMessageHandler(Helpers.PluginHttpClients.CreateDiscoveryHandler);
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.TmdbClient);
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.AssetsClient);
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.JikanClient, client =>
            {
                client.BaseAddress = new Uri("https://api.jikan.moe/v4/");
                client.Timeout = TimeSpan.FromSeconds(10);
            }).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.AniListClient, client =>
            {
                client.BaseAddress = new Uri("https://graphql.anilist.co/");
                client.Timeout = TimeSpan.FromSeconds(10);
            }).ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });
            // Dedicated JellyfinCanopy_*.log sink (a documented product feature)
            // plus a closed-generic ILogger<T> registration for every plugin type.
            // Each FileForwardingLogger<T> writes the file AND forwards to the host
            // (Serilog) logger, exactly like the former custom Logger. Self-wiring
            // closed generics is deliberate: Jellyfin boots with UseSerilog() and no
            // LoggerProviderCollection, so a DI-registered ILoggerProvider would
            // never be invoked; and the closed generics only override ILogger<T>
            // for this assembly's types, never for Jellyfin core categories.
            serviceCollection.AddSingleton<Logging.JellyfinCanopyFileLoggerProvider>();
            foreach (var consumerType in typeof(PluginServiceRegistrator).Assembly.GetTypes())
            {
                if (!consumerType.IsClass || consumerType.IsAbstract || consumerType.IsGenericTypeDefinition || consumerType.IsNested)
                {
                    continue;
                }

                var serviceType = typeof(Microsoft.Extensions.Logging.ILogger<>).MakeGenericType(consumerType);
                var implementationType = typeof(Logging.FileForwardingLogger<>).MakeGenericType(consumerType);
                serviceCollection.AddSingleton(serviceType, sp => ActivatorUtilities.CreateInstance(sp, implementationType));
            }

            // The platform kernel's only route to Jellyfin. Registering the interface
            // rather than the adapter is the point: kernel code that takes IPlatformHost
            // stays extractable, and PlatformHostSeamTests fails the build if any kernel
            // file reaches past it to MediaBrowser directly (risk R-07).
            serviceCollection.AddSingleton<Platform.Hosting.IPlatformHost, Platform.Hosting.Jellyfin.JellyfinPlatformHost>();

            // Live view over the plugin configuration (re-read per access, never
            // snapshotted) so admin saves take effect immediately in consumers.
            serviceCollection.AddSingleton<Services.IPluginConfigProvider, Services.PluginConfigProvider>();
            serviceCollection.AddSingleton(new Services.Maintainerr.MaintainerrHostIdentity(applicationHost.SystemId));
            serviceCollection.AddSingleton<Services.Maintainerr.IMaintainerrClient, Services.Maintainerr.MaintainerrClient>();
            serviceCollection.AddSingleton<Services.Discovery.ServiceDiscoveryService>();
            serviceCollection.AddSingleton(serviceProvider =>
                new Services.ClientRefreshStateService(
                    serviceProvider.GetRequiredService<Services.IPluginConfigProvider>(),
                    applicationHost.SystemId,
                    applicationHost.ApplicationVersionString));
            serviceCollection.AddSingleton<Services.AnimeFiller.IAnimeFillerProvider, Services.AnimeFiller.JikanAnimeFillerProvider>();
            serviceCollection.AddSingleton<Services.AnimeFiller.AnimeFillerService>();
            // Provider-id → item lookups via the supported ILibraryManager query
            // surface (replaces the former raw EF access to Jellyfin's internal DB).
            serviceCollection.AddSingleton<Data.IItemLookupService, Data.ItemLookupService>();
            // Process-wide Seerr/TMDB caches (formerly the static SeerrCaches
            // holder). Must stay a singleton: controllers, the user-import task
            // and the plugin's config-change hook all share one instance.
            serviceCollection.AddSingleton<Services.Seerr.ISeerrCache, Services.Seerr.SeerrCache>();
            // One process-wide owner for bounded avatar streaming, per-key cold-flight
            // coalescing, outage backoff and last-good publication.
            serviceCollection.AddSingleton<Services.Seerr.AvatarFetchService>();
            // Server-side parental-rating filter for Seerr search/discovery results.
            // Injected into SeerrClient; must NOT depend on ISeerrClient
            // (that would be a DI cycle) — it fetches per-item certifications via the
            // low-level SeerrHttpHelper instead.
            serviceCollection.AddSingleton<Services.Seerr.ISeerrParentalFilter, Services.Seerr.SeerrParentalFilter>();
            // All Seerr plumbing (user resolution + auto-import, proxy core,
            // watchlist/request helpers) extracted from the controller base.
            // Singleton: stateless besides the injected ISeerrCache.
            serviceCollection.AddSingleton<Services.Seerr.ISeerrClient, Services.Seerr.SeerrClient>();
            // Shared SSRF-guarded Sonarr/Radarr fetch plumbing for the Arr controllers.
            serviceCollection.AddSingleton<Services.Arr.ArrFetchService>();
            // Bounded, privacy-safe lifecycle/history owner shared by Requests and admin status.
            serviceCollection.AddSingleton<Services.Arr.ArrDownloadActivityService>();
            // Search / Interactive Search feature: itemId → arr identity resolution, instance
            // discovery, and the search/grab/monitor/add orchestration behind ArrSearchController.
            serviceCollection.AddSingleton<Services.Arr.IArrItemResolver, Services.Arr.ArrItemResolver>();
            serviceCollection.AddSingleton<Services.Arr.ArrTargetResolver>();
            serviceCollection.AddSingleton<Services.Arr.ArrActionService>();
            // Live config hot-reload: subscribes to the plugin's ConfigurationChanged
            // (via IPluginManager), flushes the Seerr caches and pushes a JC-marked
            // GeneralCommand to open sessions so admin saves hot-reload with no
            // manual refresh. Replaces the former SeerrCache.Instance static bridge.
            // The registry scopes the push to devices that actually run the JC
            // client (populated by authenticated public-config fetches) so native
            // clients never receive the carrier command.
            serviceCollection.AddSingleton<Services.ILiveSessionRegistry, Services.LiveSessionRegistry>();
            serviceCollection.AddHostedService<Services.LiveNotifierService>();
            serviceCollection.AddSingleton<UserConfigurationManager>();
            // One HTTP-free policy owner for exact, freshly accessible Hidden Content
            // item decisions. Legacy routes and Platform adapters share this instance.
            serviceCollection.AddSingleton<IHiddenContentItemActionOwner, HiddenContentItemActionOwner>();
            serviceCollection.AddSingleton<HiddenContentPlatformItemActionAdapter>();
            serviceCollection.AddSingleton<AutoSeasonRequestService>();
            serviceCollection.AddSingleton<AutoSeasonRequestMonitor>();
            serviceCollection.AddSingleton<AutoMovieRequestService>();
            serviceCollection.AddSingleton<AutoMovieRequestMonitor>();
            serviceCollection.AddSingleton<WatchlistMonitor>();
            serviceCollection.AddSingleton<SeerrScanTriggerService>();
            serviceCollection.AddSingleton<TagCacheService>();
            serviceCollection.AddSingleton<TagCacheProjectionRevisionService>();
            serviceCollection.AddSingleton<TagCacheMonitor>();
            serviceCollection.AddTransient<ArrTagsSyncTask>();
            serviceCollection.AddTransient<BuildTagCacheTask>();
            serviceCollection.AddTransient<SeerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyfinToSeerrWatchlistSyncTask>();
            serviceCollection.AddTransient<SeerrUserImportTask>();
            serviceCollection.AddTransient<ClearTranslationCacheTask>();
            // Local mirror of the third-party CDN assets the client scripts use, served at
            // /JellyfinCanopy/assets/* and refreshed daily by RefreshCachedAssetsTask —
            // browsers make zero requests to third-party CDNs.
            serviceCollection.AddSingleton<AssetCacheService>();
            serviceCollection.AddTransient<RefreshCachedAssetsTask>();

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints). Same filter handles "Remove from
            // Continue Watching" via HideScope=continuewatching in hidden-content.json.
            serviceCollection.AddSingleton<MaintenanceModeService>();
            serviceCollection.AddHostedService(serviceProvider => serviceProvider.GetRequiredService<MaintenanceModeService>());
            serviceCollection.AddSingleton<HiddenContentHierarchyResolver>();
            serviceCollection.AddSingleton<HiddenContentResponseFilter>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, ContinueWatchingPlaybackConsumer>();
            serviceCollection.AddHostedService<ContinueWatchingLibraryHook>();
            serviceCollection.Configure<MvcOptions>(o => o.Filters.AddService<HiddenContentResponseFilter>());

            // Spoiler Guard: two MVC action filters (image-byte substitution +
            // DTO field stripping) plus their shared user-resolver, the SkiaSharp
            // blur/stock-card engine, the Seerr pending-entry promoter, and the
            // S1E1 first-play auto-enable event consumer. All per-user state lives
            // in spoilerblur.json; both filters no-op fast when the master switch
            // is off. The field-strip filter is registered BEFORE the image filter,
            // both AFTER HiddenContentResponseFilter, so hidden items are dropped
            // first, then surviving DTOs are stripped, then image bytes rewritten.
            serviceCollection.AddSingleton<ImageBlurService>();
            serviceCollection.AddSingleton<SpoilerIdentityService>();
            // The plugin-wide "who is making this request?" ladder
            // (Services/Identity) — consumed by SpoilerUserResolver today and
            // available to any future feature that needs per-user behavior on
            // anonymous requests.
            serviceCollection.AddSingleton<RequestIdentityService>();
            serviceCollection.AddSingleton<SpoilerIdentityTagFilter>();
            serviceCollection.AddSingleton<SpoilerUserResolver>();
            serviceCollection.AddSingleton<ISpoilerGuardItemActionOwner, SpoilerGuardItemActionOwner>();
            serviceCollection.AddSingleton<SpoilerGuardPlatformItemActionAdapter>();
            serviceCollection.AddSingleton<SpoilerBlurImageFilter>();
            serviceCollection.AddSingleton<SpoilerFieldStripFilter>();
            // Shared pre-acquisition ("pending") pending-add core used by BOTH the
            // SpoilerGuardController HTTP endpoints and SeerrClient's durable
            // auto-request success boundary. Depends only on the config store + library +
            // user managers (never ISeerrClient), so it stays cycle-free.
            serviceCollection.AddSingleton<SpoilerPendingService>();
            serviceCollection.AddHostedService<SpoilerSeerrPendingPromoter>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, SpoilerAutoEnableOnFirstPlayConsumer>();
            // Identity-cache invalidation on user create/delete — the
            // single-user shortcut and marker map must never serve a stale
            // view of WHO EXISTS (see EventHandlers/UserTopologyEvents).
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserCreatedEventArgs>, UserCreatedIdentityInvalidator>();
            serviceCollection.AddScoped<IEventConsumer<Jellyfin.Data.Events.Users.UserDeletedEventArgs>, UserDeletedIdentityInvalidator>();
            serviceCollection.Configure<MvcOptions>(o =>
            {
                // Identity-tag stamping is registered FIRST so its
                // post-processing runs LAST (filters unwind inner-to-outer):
                // it must see the strip filter's final "sb-…-" cache-bust
                // prefix to append the user marker onto the FINAL tag string
                // and re-key ImageBlurHashes to exactly what clients hold.
                o.Filters.AddService<SpoilerIdentityTagFilter>();
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }

        internal static void RegisterMaintainerrHttpClient(IServiceCollection serviceCollection)
        {
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.MaintainerrClient)
                // Default IHttpClientFactory logging includes the full RequestUri.
                // Maintainerr targets are private-network topology and item routes
                // contain Jellyfin IDs, so only MaintainerrClient's redacted,
                // endpoint-enum logs are permitted for this named client.
                .RemoveAllLoggers()
                .ConfigurePrimaryHttpMessageHandler(Helpers.PluginHttpClients.CreateMaintainerrHandler);
        }
    }
}
