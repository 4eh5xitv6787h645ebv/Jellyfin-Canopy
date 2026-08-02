using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Gives every Platform v1 request a correlation id, puts that id on the response and
    /// on every log line the request produces, and converts anything that escapes an
    /// action into the one error envelope.
    ///
    /// <para>
    /// <b>Why an action filter and not middleware.</b> This is the mechanism that keeps
    /// the envelope on the correct side of the authorization boundary. Middleware runs
    /// BEFORE authorization, so it would wrap <c>401</c>/<c>403</c> too — and EP-00
    /// measured that Jellyfin 12 returns both with zero body bytes (spike-evidence S9).
    /// Action filters run only once authorization has already succeeded, so an
    /// unauthenticated request short-circuits before this type ever executes and its
    /// response stays bare, exactly as ADR-0002 requires. The placement is the contract,
    /// not an implementation detail.
    /// </para>
    /// </summary>
    public sealed class PlatformRequestFilter : IAsyncActionFilter, IAsyncExceptionFilter, IOrderedFilter
    {
        private readonly ILogger<PlatformRequestFilter> _logger;

        /// <summary>Initializes a new instance of the <see cref="PlatformRequestFilter"/> class.</summary>
        /// <param name="logger">Receives the scoped correlation id and any unhandled failure.</param>
        public PlatformRequestFilter(ILogger<PlatformRequestFilter> logger)
        {
            _logger = logger;
        }

        /// <inheritdoc />
        public int Order => int.MinValue;

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            if (IsCallerCancelled(context.HttpContext))
            {
                RestoreCallerToken(context.HttpContext);
                context.Result = new Microsoft.AspNetCore.Mvc.EmptyResult();
                return;
            }

            var correlationId = PlatformCorrelation.For(context.HttpContext);

            // ApiController's automatic model-state filter normally emits ProblemDetails.
            // This filter is ordered ahead of it so malformed JSON and unknown enum values
            // stay inside the one Platform error contract without exposing serializer text.
            if (!context.ModelState.IsValid)
            {
                RestoreCallerToken(context.HttpContext);
                var field = context.ModelState
                    .Where(entry => entry.Value?.Errors.Count > 0)
                    .Select(entry => NormalizeField(entry.Key))
                    .FirstOrDefault(value => value.Length > 0);

                context.Result = PlatformResults.Error(
                    PlatformErrorCode.InvalidRequest,
                    field is null
                        ? "The request body is invalid."
                        : $"The request field '{field}' is invalid.",
                    correlationId);
                context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
                return;
            }

            // The scope is what makes the id appear on log lines written by the action
            // itself, not just on the ones written here. That is the whole point - an id
            // that only appears in the envelope correlates a response with nothing.
            using (_logger.BeginScope(new Dictionary<string, object>
            {
                ["CorrelationId"] = correlationId,
            }))
            {
                await next().ConfigureAwait(false);
            }

            // Platform v1 is deliberately non-streaming. Publishing after action
            // execution means a caller cancellation never receives a synthetic write,
            // while ordinary result serialization has not started yet.
            if (!IsCallerCancelled(context.HttpContext) && !context.HttpContext.Response.HasStarted)
            {
                context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
            }
        }

        internal static string NormalizeField(string? path)
        {
            if (string.IsNullOrWhiteSpace(path))
            {
                return string.Empty;
            }

            var field = path.Trim().TrimStart('$', '.');
            var separator = field.LastIndexOfAny(new[] { '.', '[', ']' });
            if (separator >= 0 && separator + 1 < field.Length)
            {
                field = field[(separator + 1)..];
            }

            return new string(field.Where(character => char.IsLetterOrDigit(character) || character == '_').ToArray());
        }

        /// <inheritdoc />
        public Task OnExceptionAsync(ExceptionContext context)
        {
            ArgumentNullException.ThrowIfNull(context);

            if (context.Exception is OperationCanceledException
                && PlatformRequestLifecycleState.TryGet(context.HttpContext, out var lifecycle))
            {
                // Caller cancellation wins when both tokens race. A disconnected caller
                // gets no attempted write and no synthetic server-fault log.
                if (lifecycle.CallerToken.IsCancellationRequested)
                {
                    context.HttpContext.RequestAborted = lifecycle.CallerToken;
                    lifecycle.StopDeadline();
                    context.Result = new Microsoft.AspNetCore.Mvc.EmptyResult();
                    context.ExceptionHandled = true;
                    return Task.CompletedTask;
                }

                if (lifecycle.DeadlineToken.IsCancellationRequested)
                {
                    context.HttpContext.RequestAborted = lifecycle.CallerToken;
                    lifecycle.StopDeadline();
                    if (context.HttpContext.Response.HasStarted)
                    {
                        context.Result = new Microsoft.AspNetCore.Mvc.EmptyResult();
                        context.ExceptionHandled = true;
                        return Task.CompletedTask;
                    }

                    var timeoutCorrelationId = PlatformCorrelation.For(context.HttpContext);
                    context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = timeoutCorrelationId;
                    context.Result = PlatformResults.Error(
                        PlatformErrorCode.Timeout,
                        "The request exceeded the Platform v1 deadline.",
                        timeoutCorrelationId);
                    context.ExceptionHandled = true;
                    return Task.CompletedTask;
                }
            }

            var correlationId = PlatformCorrelation.For(context.HttpContext);
            RestoreCallerToken(context.HttpContext);
            if (!context.HttpContext.Response.HasStarted)
            {
                context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
            }

            // The detail goes HERE and only here. The caller gets a fixed message and the
            // id; everything that would help an attacker - type, message, stack, paths -
            // stays server-side, joined to the response only by the correlation id.
            _logger.LogError(
                context.Exception,
                "Unhandled Platform v1 failure. CorrelationId={CorrelationId}",
                correlationId);

            if (context.HttpContext.Response.HasStarted)
            {
                context.Result = new Microsoft.AspNetCore.Mvc.EmptyResult();
                context.ExceptionHandled = true;
                return Task.CompletedTask;
            }

            context.Result = PlatformResults.Error(
                PlatformErrorCode.InternalError,
                "The server failed to complete this request.",
                correlationId);

            // Marking it handled is what prevents the host's default error page, which
            // would otherwise replace the envelope with a different shape entirely.
            context.ExceptionHandled = true;

            return Task.CompletedTask;
        }

        private static void RestoreCallerToken(Microsoft.AspNetCore.Http.HttpContext context)
        {
            if (PlatformRequestLifecycleState.TryGet(context, out var lifecycle))
            {
                context.RequestAborted = lifecycle.CallerToken;
                lifecycle.StopDeadline();
            }
        }

        private static bool IsCallerCancelled(Microsoft.AspNetCore.Http.HttpContext context) =>
            PlatformRequestLifecycleState.TryGet(context, out var lifecycle)
            && lifecycle.CallerToken.IsCancellationRequested;
    }
}
