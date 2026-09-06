using System;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    /// <summary>
    /// Prevents HTTP storage of caller-specific or administrator-private responses.
    /// Apply only to the owning action or a controller whose entire surface is private.
    /// </summary>
    /// <remarks>
    /// Runs for MVC short-circuit results as well as successful actions. Host
    /// authentication middleware remains responsible for rejections before MVC.
    /// Unlike a response-cache action filter, this preserves existing Vary headers
    /// and representation validators: ETags still support settings concurrency even
    /// when the representation must not be stored by browsers or intermediaries.
    /// This is constant header work; it does not invalidate application caches.
    /// </remarks>
    [AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, Inherited = true)]
    public sealed class PrivateResponseAttribute : Attribute, IAlwaysRunResultFilter
    {
        /// <inheritdoc />
        public void OnResultExecuting(ResultExecutingContext context)
        {
            var headers = context.HttpContext.Response.Headers;
            headers.CacheControl = "private, no-store, no-cache";
            headers.Pragma = "no-cache";
            headers.Expires = "0";
        }

        /// <inheritdoc />
        public void OnResultExecuted(ResultExecutedContext context)
        {
        }
    }
}
