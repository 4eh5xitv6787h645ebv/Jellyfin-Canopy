using System;
using System.Buffers;
using System.IO;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Enforces <see cref="PlatformRequestBounds"/> on every Platform v1 request body.
    ///
    /// <para>
    /// <b>Why a resource filter, and why <see cref="Order"/> is near <see cref="int.MinValue"/>.</b>
    /// Resource filters run after authorization but <i>before</i> model binding, which is
    /// the only window where a body can be refused without first deserializing it —
    /// deserializing to find out whether it was too big to deserialize is the cost this
    /// exists to avoid. Actor and media-type checks occupy the two earlier deterministic
    /// resource-filter slots, so no body byte is acquired before they pass. The same
    /// placement the existing
    /// <c>PersistedPayloadLimitAttribute</c> uses, for the same reason.
    /// </para>
    /// <para>
    /// Being after authorization also keeps the structured body on the right side of the
    /// boundary: an unauthenticated caller still gets the host's bare 401/403 and never
    /// reaches this (ADR-0002).
    /// </para>
    /// <para>
    /// <b>Declared length is checked but not trusted.</b> <c>Content-Length</c> lets an
    /// oversized request be refused before a byte is read, but a chunked body declares no
    /// length at all, and a declared length can simply be wrong. So the stream is also
    /// counted as it is buffered, and both paths produce the same structured answer.
    /// </para>
    /// </summary>
    public sealed class PlatformBoundedBodyFilter : IAsyncResourceFilter, IOrderedFilter
    {
        private const int CopyBufferBytes = 81_920;

        /// <inheritdoc />
        public int Order => PlatformFilterOrder.BoundedBody;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            var request = context.HttpContext.Request;

            // Refuse on the declared length before reading anything, when there is one.
            if (request.ContentLength > PlatformRequestBounds.MaximumBytes)
            {
                Reject(context, new PlatformBoundBreach("bytes", PlatformRequestBounds.MaximumBytes));
                return;
            }

            if (request.ContentLength is null or 0 && !request.Body.CanRead)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var originalBody = request.Body;
            using var buffered = new MemoryStream();
            var rented = ArrayPool<byte>.Shared.Rent(CopyBufferBytes);
            var pipelineInvoked = false;

            try
            {
                long total = 0;
                while (true)
                {
                    var read = await originalBody
                        .ReadAsync(rented.AsMemory(0, CopyBufferBytes), context.HttpContext.RequestAborted)
                        .ConfigureAwait(false);

                    if (read == 0)
                    {
                        break;
                    }

                    total += read;
                    if (total > PlatformRequestBounds.MaximumBytes)
                    {
                        // Stop reading immediately. Continuing to drain a body already
                        // known to be over the limit is the denial-of-service the limit
                        // is for.
                        Reject(context, new PlatformBoundBreach("bytes", PlatformRequestBounds.MaximumBytes));
                        return;
                    }

                    await buffered
                        .WriteAsync(rented.AsMemory(0, read), context.HttpContext.RequestAborted)
                        .ConfigureAwait(false);
                }

                var breach = PlatformRequestBounds.FirstBreach(buffered.GetBuffer().AsSpan(0, (int)buffered.Length));
                if (breach is not null)
                {
                    Reject(context, breach.Value);
                    return;
                }

                // Hand the buffered copy on: the original stream has been consumed, so
                // model binding would otherwise see an empty body.
                buffered.Position = 0;
                request.Body = buffered;
                pipelineInvoked = true;
                await next().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!pipelineInvoked && context.HttpContext.RequestAborted.IsCancellationRequested)
            {
                // The peer disconnected while its body was still being buffered. There is
                // no client left to receive an answer.
            }
            finally
            {
                request.Body = originalBody;
                ArrayPool<byte>.Shared.Return(rented);
            }
        }

        private static void Reject(ResourceExecutingContext context, PlatformBoundBreach breach)
        {
            // The correlation id is taken from the same place the action filter would
            // take it. This rejection happens BEFORE that filter runs, so without this the
            // one response a consumer most needs to report would be the one with no id.
            var correlationId = PlatformCorrelation.For(context.HttpContext);
            context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;

            context.Result = PlatformResults.Error(
                PlatformErrorCode.PayloadTooLarge,
                $"The request exceeds the platform limit for {breach.Axis} ({breach.Limit}).",
                correlationId);
        }
    }
}
