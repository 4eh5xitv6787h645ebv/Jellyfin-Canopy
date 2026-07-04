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
            // Seerr calls.
            serviceCollection.AddHttpClient(Helpers.Jellyseerr.SeerrHttpHelper.NamedClient)
                .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
                {
                    AllowAutoRedirect = false
                });

            // Named clients for the remaining upstreams (see PluginHttpClients for
            // the per-upstream rationale). Both use the default handler — redirects
            // followed — and keep the .NET default 100s timeout; call sites that need
            // a shorter deadline set it per factory-created instance. API keys are
            // attached per-request (HttpRequestMessage), never via DefaultRequestHeaders.
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.ArrClient);
            serviceCollection.AddHttpClient(Helpers.PluginHttpClients.TmdbClient);
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

            // Hidden Content: server-side filter for every native Jellyfin endpoint that surfaces user-facing item lists
            // (Resume, Items, Latest, NextUp, Upcoming, Suggestions, SearchHints). Same filter handles "Remove from
            // Continue Watching" via HideScope=continuewatching in hidden-content.json.
            serviceCollection.AddSingleton<MaintenanceModeService>();
            serviceCollection.AddSingleton<HiddenContentResponseFilter>();
            serviceCollection.AddScoped<IEventConsumer<PlaybackStartEventArgs>, ContinueWatchingPlaybackConsumer>();
            serviceCollection.AddHostedService<ContinueWatchingLibraryHook>();
            serviceCollection.Configure<MvcOptions>(o => o.Filters.AddService<HiddenContentResponseFilter>());
        }
    }
}