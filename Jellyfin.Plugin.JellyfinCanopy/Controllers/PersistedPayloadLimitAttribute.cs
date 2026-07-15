using System;
using System.Buffers;
using System.IO;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    public sealed class PersistedPayloadErrorResponse
    {
        public bool Success { get; set; }

        public string Code { get; set; } = string.Empty;

        public string Message { get; set; } = string.Empty;
    }

    /// <summary>
    /// Buffers a bounded request before MVC model binding so declared-length and
    /// chunked bodies receive the same structured rejection without deserializing.
    /// </summary>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
    internal sealed class PersistedPayloadLimitAttribute : Attribute, IAsyncResourceFilter, IOrderedFilter
    {
        private const int CopyBufferBytes = 81_920;
        private readonly long _maximumBytes;

        public PersistedPayloadLimitAttribute(long maximumBytes)
        {
            if (maximumBytes <= 0)
            {
                throw new ArgumentOutOfRangeException(nameof(maximumBytes));
            }

            _maximumBytes = maximumBytes;
        }

        public int Order => int.MinValue;

        internal long MaximumBytes => _maximumBytes;

        public async Task OnResourceExecutionAsync(
            ResourceExecutingContext context,
            ResourceExecutionDelegate next)
        {
            var request = context.HttpContext.Request;
            if (request.ContentLength > _maximumBytes)
            {
                await RejectAsync(context.HttpContext).ConfigureAwait(false);
                return;
            }

            var originalBody = request.Body;
            await using var buffered = new MemoryStream();
            var rented = ArrayPool<byte>.Shared.Rent(CopyBufferBytes);
            var pipelineInvoked = false;
            try
            {
                long total = 0;
                while (true)
                {
                    var read = await originalBody.ReadAsync(
                        rented.AsMemory(0, CopyBufferBytes),
                        context.HttpContext.RequestAborted).ConfigureAwait(false);
                    if (read == 0)
                    {
                        break;
                    }

                    total += read;
                    if (total > _maximumBytes)
                    {
                        await RejectAsync(context.HttpContext).ConfigureAwait(false);
                        return;
                    }

                    await buffered.WriteAsync(
                        rented.AsMemory(0, read),
                        context.HttpContext.RequestAborted).ConfigureAwait(false);
                }

                buffered.Position = 0;
                request.Body = buffered;
                pipelineInvoked = true;
                await next().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!pipelineInvoked && context.HttpContext.RequestAborted.IsCancellationRequested)
            {
                // The peer disconnected while its body was still being buffered.
                // There is no client left to receive an error response.
            }
            finally
            {
                request.Body = originalBody;
                ArrayPool<byte>.Shared.Return(rented);
            }
        }

        private static Task RejectAsync(HttpContext context)
        {
            context.Response.StatusCode = StatusCodes.Status413PayloadTooLarge;
            return context.Response.WriteAsJsonAsync(new PersistedPayloadErrorResponse
            {
                Code = "payload_too_large",
                Message = "The request payload exceeds the supported size limit."
            }, context.RequestAborted);
        }
    }
}
