using System.Net.Http;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    /// <summary>
    /// Named <see cref="IHttpClientFactory"/> clients for the plugin's non-Seerr
    /// upstreams, registered in <c>PluginServiceRegistrator</c>. (The Seerr client
    /// lives in <see cref="Seerr.SeerrHttpHelper"/> because it carries
    /// Seerr-specific handler behavior — AllowAutoRedirect=false.)
    ///
    /// Hygiene rules enforced here:
    ///   - never mutate <c>DefaultRequestHeaders</c> on a factory client — API keys
    ///     go on the <see cref="HttpRequestMessage"/> via <see cref="BuildArrRequest"/>;
    ///   - both clients keep the .NET default 100-second timeout. Call sites that
    ///     need a shorter deadline set <c>HttpClient.Timeout</c> on their own
    ///     factory-created instance (instance-scoped, so this is safe) — the long
    ///     default exists for ArrTagService's full-library tag sync, which can
    ///     legitimately take minutes' worth of paging on large libraries.
    /// </summary>
    public static class PluginHttpClients
    {
        /// <summary>
        /// Sonarr/Radarr client. Follows redirects (default handler): arr instances
        /// are commonly fronted by reverse proxies that 301/302 between http↔https
        /// or trailing-slash variants, where a redirect is normal canonicalization —
        /// unlike Seerr, where a 302 to a login URL is a security signal.
        /// </summary>
        public const string ArrClient = "JellyfinCanopyArr";

        /// <summary>TMDB client (api.themoviedb.org; the API key travels in the query string).</summary>
        public const string TmdbClient = "JellyfinCanopyTmdb";

        /// <summary>
        /// Asset-cache client (the allowlisted CDN upstreams in <c>AssetCacheManifest</c>).
        /// No credentials ever travel on these requests.
        /// </summary>
        public const string AssetsClient = "JellyfinCanopyAssets";

        /// <summary>Fixed-origin, credential-free Jikan REST API client.</summary>
        public const string JikanClient = "JellyfinCanopyJikan";

        /// <summary>Fixed-origin, credential-free AniList GraphQL client.</summary>
        public const string AniListClient = "JellyfinCanopyAniList";

        /// <summary>
        /// Credential-free Maintainerr v3.18 client. Registration disables redirects
        /// and uses the same connect-time SSRF fence as other private-network services.
        /// </summary>
        public const string MaintainerrClient = "JellyfinCanopyMaintainerr";

        public static HttpClient CreateArrClient(IHttpClientFactory factory)
        {
            // Same fallback pattern as SeerrHttpHelper.CreateClient: if the named
            // registration is unavailable, degrade to the unnamed default client.
            try { return factory.CreateClient(ArrClient); }
            catch { return factory.CreateClient(); }
        }

        public static HttpClient CreateTmdbClient(IHttpClientFactory factory)
        {
            try { return factory.CreateClient(TmdbClient); }
            catch { return factory.CreateClient(); }
        }

        public static HttpClient CreateMaintainerrClient(IHttpClientFactory factory)
            // Unlike the general arr client, Maintainerr is an admin-configured
            // private-network origin. Falling back to the unnamed client would
            // silently lose the no-redirect and connect-time SSRF guarantees.
            => factory.CreateClient(MaintainerrClient);

        /// <summary>
        /// Credential-free service auto-discovery client. Targets are
        /// server-chosen private-network candidates, so it must use the
        /// connect-time SSRF fence; like Maintainerr, no unguarded fallback.
        /// </summary>
        public const string DiscoveryClient = "JellyfinCanopyDiscovery";

        public static HttpClient CreateDiscoveryClient(IHttpClientFactory factory)
            => factory.CreateClient(DiscoveryClient);

        internal static SocketsHttpHandler CreateDiscoveryHandler()
        {
            // Redirects stay enabled (reverse proxies canonicalize http↔https and
            // login-page redirects are how the arr UIs answer anonymous probes)
            // but tightly bounded; every hop re-passes the connect-time IP check.
            var handler = ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: true);
            handler.MaxAutomaticRedirections = 4;
            handler.UseCookies = false;
            handler.Credentials = null;
            // A proxy would resolve/connect on our behalf, bypassing ArrUrlGuard's
            // authoritative connect-time DNS-rebinding check.
            handler.UseProxy = false;
            return handler;
        }

        internal static SocketsHttpHandler CreateMaintainerrHandler()
        {
            var handler = ArrUrlGuard.CreateGuardedHandler(allowAutoRedirect: false);
            // IHttpClientFactory pools primary handlers. Disable the default cookie
            // jar so an upstream Set-Cookie can never become a credential-bearing
            // Cookie header on a later Maintainerr request.
            handler.UseCookies = false;
            handler.Credentials = null;
            // A proxy would resolve/connect to the target on our behalf, bypassing
            // ArrUrlGuard's authoritative connect-time DNS-rebinding check.
            handler.UseProxy = false;
            return handler;
        }

        /// <summary>
        /// Asset-cache client with a 30-second deadline (instance-scoped, per the hygiene rules
        /// above): CDN objects are small and a hung upstream must never pin a request thread for
        /// the .NET default 100 seconds.
        /// </summary>
        public static HttpClient CreateAssetsClient(IHttpClientFactory factory)
        {
            HttpClient client;
            try { client = factory.CreateClient(AssetsClient); }
            catch { client = factory.CreateClient(); }
            client.Timeout = System.TimeSpan.FromSeconds(30);
            return client;
        }

        /// <summary>
        /// Builds a Sonarr/Radarr request with the API key attached per-request
        /// (never on the pooled client's DefaultRequestHeaders).
        /// </summary>
        public static HttpRequestMessage BuildArrRequest(HttpMethod method, string url, string apiKey)
        {
            var request = new HttpRequestMessage(method, url);
            request.Headers.TryAddWithoutValidation("X-Api-Key", apiKey);
            return request;
        }
    }
}
