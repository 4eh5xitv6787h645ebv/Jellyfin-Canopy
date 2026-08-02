using System;
using System.Collections.Generic;
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

            var correlationId = PlatformCorrelation.For(context.HttpContext);

            // Set before the action runs: once the response has started, headers are no
            // longer writable, and a streaming action would otherwise silently lose it.
            context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;

            // ApiController's automatic model-state filter normally emits ProblemDetails.
            // This filter is ordered ahead of it so malformed JSON and unknown enum values
            // stay inside the one Platform error contract without exposing serializer text.
            if (!context.ModelState.IsValid)
            {
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

            var correlationId = PlatformCorrelation.For(context.HttpContext);

            // The detail goes HERE and only here. The caller gets a fixed message and the
            // id; everything that would help an attacker - type, message, stack, paths -
            // stays server-side, joined to the response only by the correlation id.
            _logger.LogError(
                context.Exception,
                "Unhandled Platform v1 failure. CorrelationId={CorrelationId}",
                correlationId);

            context.Result = PlatformResults.Error(
                PlatformErrorCode.InternalError,
                "The server failed to complete this request.",
                correlationId);

            // Marking it handled is what prevents the host's default error page, which
            // would otherwise replace the envelope with a different shape entirely.
            context.ExceptionHandled = true;

            return Task.CompletedTask;
        }
    }
}
