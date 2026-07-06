using System.Net.Http;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using Jellyfin.Plugin.JellyfinEnhanced.EventHandlers;
using Jellyfin.Plugin.JellyfinEnhanced.Services;
using Jellyfin.Plugin.JellyfinEnhanced.ScheduledTasks;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using MediaBrowser.Controller;

namespace Jellyfin.Plugin.JellyfinEnhanced
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

            // a named HttpClient with AllowAutoRedirect=false so
            // forward-auth proxies (Authelia / Pangolin / Authentik) returning
            // 302 to a login URL are detected as `UpstreamRedirect` instead of
            // silently followed and producing a 200 + login HTML body.
            // SeerrHttpHelper.CreateClient(factory) selects this for outbound
            // Seerr calls. The guarded handler re-validates the connect-time IP
            // (DNS-rebind / TOCTOU defense) on top of the pre-flight URL guard.
            serviceCollection.AddHttpClient(Helpers.Jellyseerr.SeerrHttpHelper.NamedClient)
                .ConfigurePrimaryHttpMessageHandler(() => Helpers.ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: false));

            // Named clients for the remaining upstreams (see PluginHttpClients for
            // the per-upstream rationale). The Arr client points at admin-supplied
            // Sonarr/Radarr URLs, so it routes through the guarded handler (connect-time
            // IP re-check) while keeping AllowAutoRedirect=true. TmdbClient/AssetsClient
            // target hardcoded/allowlisted CDNs and keep the default handler. API keys
            // are attached per-request (HttpRequestMessage), never via DefaultRequestHeaders.
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.ArrClient)
                .ConfigurePrimaryHttpMessageHandler(() => Helpers.ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: true));
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.TmdbClient);
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.AssetsClient);
            // Dedicated JellyfinEnhanced_*.log sink (a documented product feature)
            // plus a closed-generic ILogger<T> registration for every plugin type.
            // Each FileForwardingLogger<T> writes the file AND forwards to the host
            // (Serilog) logger, exactly like the former custom Logger. Self-wiring
            // closed generics is deliberate: Jellyfin boots with UseSerilog() and no
            // LoggerProviderCollection, so a DI-registered ILoggerProvider would
            // never be invoked; and the closed generics only override ILogger<T>
            // for this assembly's types, never for Jellyfin core categories.
            serviceCollection.AddSingleton<Logging.JellyfinEnhancedFileLoggerProvider>();
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

            // Live view over the plugin configuration (re-read per access, never
            // snapshotted) so admin saves take effect immediately in consumers.
            serviceCollection.AddSingleton<Services.IPluginConfigProvider, Services.PluginConfigProvider>();
            // Provider-id → item lookups via the supported ILibraryManager query
            // surface (replaces the former raw EF access to Jellyfin's internal DB).
            serviceCollection.AddSingleton<Data.IItemLookupService, Data.ItemLookupService>();
            // Process-wide Seerr/TMDB caches (formerly the static SeerrCaches
            // holder). Must stay a singleton: controllers, the user-import task
            // and the plugin's config-change hook all share one instance.
            serviceCollection.AddSingleton<Services.Jellyseerr.ISeerrCache, Services.Jellyseerr.SeerrCache>();
            // Server-side parental-rating filter for Seerr search/discovery results.
            // Injected into JellyseerrClient; must NOT depend on IJellyseerrClient
            // (that would be a DI cycle) — it fetches per-item certifications via the
            // low-level SeerrHttpHelper instead.
            serviceCollection.AddSingleton<Services.Jellyseerr.ISeerrParentalFilter, Services.Jellyseerr.SeerrParentalFilter>();
            // All Seerr plumbing (user resolution + auto-import, proxy core,
            // watchlist/request helpers) extracted from the controller base.
            // Singleton: stateless besides the injected ISeerrCache.
            serviceCollection.AddSingleton<Services.Jellyseerr.IJellyseerrClient, Services.Jellyseerr.JellyseerrClient>();
            // Shared SSRF-guarded Sonarr/Radarr fetch plumbing for the Arr controllers.
            serviceCollection.AddSingleton<Services.Arr.ArrFetchService>();
            // Live config hot-reload: subscribes to the plugin's ConfigurationChanged
            // (via IPluginManager), flushes the Seerr caches and pushes a JE-marked
            // GeneralCommand to open sessions so admin saves hot-reload with no
            // manual refresh. Replaces the former SeerrCache.Instance static bridge.
            serviceCollection.AddHostedService<Services.LiveNotifierService>();
            serviceCollection.AddSingleton<UserConfigurationManager>();
            serviceCollection.AddSingleton<AutoSeasonRequestService>();
            serviceCollection.AddSingleton<AutoSeasonRequestMonitor>();
            serviceCollection.AddSingleton<AutoMovieRequestService>();
            serviceCollection.AddSingleton<AutoMovieRequestMonitor>();
            serviceCollection.AddSingleton<WatchlistMonitor>();
            serviceCollection.AddSingleton<SeerrScanTriggerService>();
            serviceCollection.AddSingleton<TagCacheService>();
            serviceCollection.AddSingleton<TagCacheMonitor>();
            serviceCollection.AddTransient<ArrTagsSyncTask>();
            serviceCollection.AddTransient<BuildTagCacheTask>();
            serviceCollection.AddTransient<JellyseerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyfinToSeerrWatchlistSyncTask>();
            serviceCollection.AddTransient<JellyseerrUserImportTask>();
            serviceCollection.AddTransient<ClearTranslationCacheTask>();
            // Local mirror of the third-party CDN assets the client scripts use, served at
            // /JellyfinEnhanced/assets/* and refreshed daily by RefreshCachedAssetsTask —
            // browsers make zero requests to third-party CDNs.
            serviceCollection.AddSingleton<AssetCacheService>();
            serviceCollection.AddTransient<RefreshCachedAssetsTask>();

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints). Same filter handles "Remove from
            // Continue Watching" via HideScope=continuewatching in hidden-content.json.
            serviceCollection.AddSingleton<MaintenanceModeService>();
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
            serviceCollection.AddSingleton<SpoilerUserResolver>();
            serviceCollection.AddSingleton<SpoilerBlurImageFilter>();
            serviceCollection.AddSingleton<SpoilerFieldStripFilter>();
            // Shared pre-acquisition ("pending") pending-add core used by BOTH the
            // SpoilerGuardController HTTP endpoints and the Seerr auto-request hook on
            // JellyseerrProxyController. Depends only on the config store + library +
            // user managers (never IJellyseerrClient), so it stays cycle-free.
            serviceCollection.AddSingleton<SpoilerPendingService>();
            serviceCollection.AddHostedService<SpoilerSeerrPendingPromoter>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, SpoilerAutoEnableOnFirstPlayConsumer>();
            serviceCollection.Configure<MvcOptions>(o =>
            {
                o.Filters.AddService<SpoilerFieldStripFilter>();
                o.Filters.AddService<SpoilerBlurImageFilter>();
            });
        }
    }
}