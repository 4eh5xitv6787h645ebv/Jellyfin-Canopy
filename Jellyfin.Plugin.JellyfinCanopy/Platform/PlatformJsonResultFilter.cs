using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Routes Platform results through the pinned Platform JSON serializer.</summary>
    public sealed class PlatformJsonResultFilter : IAsyncResultFilter
    {
        /// <inheritdoc />
        public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            if (context.Result is ObjectResult { Value: not null } result)
            {
                context.Result = new JsonResult(result.Value, PlatformJson.SerializerOptions)
                {
                    StatusCode = result.StatusCode,
                    ContentType = "application/json",
                };
            }

            await next().ConfigureAwait(false);
        }
    }
}
