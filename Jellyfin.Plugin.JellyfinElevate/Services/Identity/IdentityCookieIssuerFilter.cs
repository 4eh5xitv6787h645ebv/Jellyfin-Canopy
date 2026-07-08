using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinElevate.Services
{
    /// <summary>
    /// Issues the HMAC-signed identity cookie (issue 13). On an AUTHENTICATED
    /// MVC response, when the signed-cookie feature is on, it mints
    /// <c>je-uid=&lt;signed&gt;</c> (HttpOnly, SameSite=Lax) so the browser
    /// carries it on later anonymous same-origin image/CSS fetches — where
    /// RequestIdentityService verifies it WITHOUT a session-on-IP check. Runs on
    /// controller actions only (static/image endpoints aren't MVC), which is
    /// fine: the web client makes many authenticated API calls early, so the
    /// cookie is set well before it matters.
    ///
    /// Cheap: three gate checks, then a re-set only when the incoming cookie is
    /// missing or doesn't already verify to THIS user (so it isn't rewritten on
    /// every request). Lazily generates + persists the HMAC secret on first use.
    /// </summary>
    public sealed class IdentityCookieIssuerFilter : IAsyncActionFilter
    {
        private readonly IPluginConfigProvider _config;
        private readonly ILogger<IdentityCookieIssuerFilter> _logger;
        private static readonly object _secretLock = new();

        public IdentityCookieIssuerFilter(IPluginConfigProvider config, ILogger<IdentityCookieIssuerFilter> logger)
        {
            _config = config;
            _logger = logger;
        }

        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            // Do the (cheap) work BEFORE the action so the Set-Cookie header is
            // added while the response hasn't started; setting cookies after the
            // body has begun writing is a no-op.
            TrySetCookie(context.HttpContext);
            await next().ConfigureAwait(false);
        }

        private void TrySetCookie(HttpContext http)
        {
            try
            {
                var config = _config.ConfigurationOrNull;
                if (config == null || !config.IdentitySignedCookieEnabled) return;

                var userId = Helpers.UserHelper.GetCurrentUserId(http.User);
                if (userId == null || userId.Value == Guid.Empty) return;

                var secret = EnsureSecret(config);
                if (secret == null) return;

                // Skip if the browser already presents a valid cookie for THIS
                // user — avoids re-issuing on every authenticated request.
                if (http.Request.Cookies.TryGetValue(IdentityCookieSigner.CookieName, out var existing))
                {
                    var current = IdentityCookieSigner.Verify(existing, secret, DateTime.UtcNow);
                    if (current == userId.Value) return;
                }

                var value = IdentityCookieSigner.Sign(userId.Value, secret, DateTime.UtcNow);
                if (value == null) return;

                http.Response.Cookies.Append(IdentityCookieSigner.CookieName, value, new CookieOptions
                {
                    HttpOnly = true,
                    SameSite = SameSiteMode.Lax,
                    Secure = http.Request.IsHttps,
                    IsEssential = true,
                    Path = "/",
                    MaxAge = TimeSpan.FromDays(30),
                });
            }
            catch (Exception ex)
            {
                // Never let cookie issuance break a real API response.
                _logger.LogDebug("JE identity cookie issue skipped: {Message}", ex.Message);
            }
        }

        // Returns the HMAC secret, generating+persisting one on first use when
        // the admin left it blank. Double-checked lock so concurrent first
        // requests generate exactly one secret.
        private string? EnsureSecret(Configuration.PluginConfiguration config)
        {
            var secret = config.IdentityCookieSecret;
            if (!string.IsNullOrWhiteSpace(secret) && secret.Trim().Length >= 16) return secret;

            lock (_secretLock)
            {
                var live = JellyfinElevate.Instance?.Configuration;
                if (live == null) return null;
                if (!string.IsNullOrWhiteSpace(live.IdentityCookieSecret) && live.IdentityCookieSecret.Trim().Length >= 16)
                {
                    return live.IdentityCookieSecret;
                }

                var generated = IdentityCookieSigner.GenerateSecret();
                live.IdentityCookieSecret = generated;
                try
                {
                    JellyfinElevate.Instance!.SaveConfiguration();
                }
                catch (Exception ex)
                {
                    // If persistence fails the in-memory secret still works for
                    // this process lifetime; log and continue.
                    _logger.LogWarning("JE identity cookie secret generated but not persisted: {Message}", ex.Message);
                }
                return generated;
            }
        }
    }
}
