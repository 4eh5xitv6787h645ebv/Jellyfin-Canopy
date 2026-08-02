using System;
using System.Text.Json;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Routes Platform results through the pinned Platform JSON serializer.</summary>
    public sealed class PlatformJsonResultFilter : IAsyncAlwaysRunResultFilter
    {
        /// <inheritdoc />
        public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            if (context.Result is ObjectResult { Value: not null } result)
            {
                context.Result = PlatformJsonBodyResult.Create(
                    result.Value,
                    result.StatusCode ?? StatusCodes.Status200OK);
            }

            await next().ConfigureAwait(false);
        }
    }

    /// <summary>
    /// A Platform JSON response whose exact wire bytes are known before execution.
    /// This keeps validator hashing and response output on the same representation.
    /// </summary>
    internal sealed class PlatformJsonBodyResult : ActionResult
    {
        private PlatformJsonBodyResult(byte[] body, int statusCode)
        {
            Body = body;
            StatusCode = statusCode;
        }

        internal byte[] Body { get; }

        internal int StatusCode { get; }

        internal static PlatformJsonBodyResult Create(object value, int statusCode)
        {
            ArgumentNullException.ThrowIfNull(value);
            return new PlatformJsonBodyResult(
                JsonSerializer.SerializeToUtf8Bytes(value, value.GetType(), PlatformJson.SerializerOptions),
                statusCode);
        }

        /// <inheritdoc />
        public override async Task ExecuteResultAsync(ActionContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            var response = context.HttpContext.Response;
            response.StatusCode = StatusCode;
            response.ContentType = "application/json";
            // Platform validators name these exact bytes. Pinning the identity content
            // coding prevents the host compression middleware from turning one strong
            // validator into a validator for multiple byte-distinct representations.
            // Current discovery/negotiation envelopes are deliberately tiny.
            response.Headers.ContentEncoding = "identity";
            response.ContentLength = Body.Length;
            await response.Body.WriteAsync(Body, context.HttpContext.RequestAborted).ConfigureAwait(false);
        }
    }
}
