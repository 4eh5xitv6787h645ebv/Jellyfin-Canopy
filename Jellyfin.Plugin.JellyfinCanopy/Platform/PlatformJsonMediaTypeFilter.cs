using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Refuses non-JSON Platform request bodies before model binding.</summary>
    public sealed class PlatformJsonMediaTypeFilter : IAsyncResourceFilter, IOrderedFilter
    {
        /// <inheritdoc />
        public int Order => int.MinValue;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            var request = context.HttpContext.Request;
            var bodyFeature = context.HttpContext.Features.Get<IHttpRequestBodyDetectionFeature>();
            var hasBody = bodyFeature?.CanHaveBody
                ?? request.ContentLength > 0
                || request.Headers.ContainsKey("Transfer-Encoding");

            if (!hasBody || IsJson(request.ContentType))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var correlationId = PlatformCorrelation.For(context.HttpContext);
            context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
            context.Result = PlatformResults.Error(
                PlatformErrorCode.UnsupportedMediaType,
                "Platform request bodies must use a JSON media type.",
                correlationId);
        }

        internal static bool IsJson(string? contentType)
        {
            var mediaType = contentType?.Split(';', 2, StringSplitOptions.TrimEntries)[0];
            return string.Equals(mediaType, "application/json", StringComparison.OrdinalIgnoreCase);
        }
    }
}
