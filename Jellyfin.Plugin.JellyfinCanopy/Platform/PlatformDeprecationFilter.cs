using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Adds RFC deprecation metadata to operations named by the shipped registry.</summary>
    public sealed class PlatformDeprecationFilter : IAsyncAlwaysRunResultFilter, IOrderedFilter
    {
        private readonly PlatformDeprecationRegistry _registry;

        /// <summary>Initializes the filter over the immutable shipped registry.</summary>
        public PlatformDeprecationFilter()
            : this(PlatformDeprecationRegistry.Shipped)
        {
        }

        internal PlatformDeprecationFilter(PlatformDeprecationRegistry registry)
        {
            _registry = registry ?? throw new ArgumentNullException(nameof(registry));
        }

        /// <inheritdoc />
        public int Order => PlatformFilterOrder.Deprecation;

        /// <inheritdoc />
        public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            var request = context.HttpContext.Request;
            if (!context.HttpContext.Response.HasStarted
                && PlatformOperationIdentity.TryDescribe(context.ActionDescriptor, request.Method, out var method, out var path)
                && _registry.TryGet(method, path, out var entry))
            {
                context.HttpContext.Response.Headers["Deprecation"] = entry.DeprecationHeader;
                context.HttpContext.Response.Headers["Sunset"] = entry.SunsetHeader;
            }

            await next().ConfigureAwait(false);
        }
    }
}
