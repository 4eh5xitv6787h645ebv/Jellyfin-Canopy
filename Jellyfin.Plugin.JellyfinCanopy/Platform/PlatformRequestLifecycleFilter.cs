using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// Gives model binding and every Platform v1 action one linked cancellation token:
    /// the caller's disconnect token plus the kernel's fixed request deadline.
    /// </summary>
    /// <remarks>
    /// This is a resource filter so the linked token is installed before model binding.
    /// Its order places it immediately inside <see cref="PlatformBoundedBodyFilter"/>:
    /// bounded body acquisition observes the caller token, then the deadline begins.
    /// Platform v1 actions are non-streaming; a response that has started cannot safely
    /// be replaced with the timeout envelope.
    /// </remarks>
    public sealed class PlatformRequestLifecycleFilter :
        IAsyncResourceFilter,
        IAsyncActionFilter,
        IAsyncAlwaysRunResultFilter,
        IOrderedFilter
    {
        private readonly TimeProvider _timeProvider;

        /// <summary>Initializes the production lifecycle with the system clock.</summary>
        public PlatformRequestLifecycleFilter()
            : this(TimeProvider.System)
        {
        }

        internal PlatformRequestLifecycleFilter(TimeProvider timeProvider)
        {
            _timeProvider = timeProvider ?? throw new ArgumentNullException(nameof(timeProvider));
        }

        /// <inheritdoc />
        public int Order => PlatformFilterOrder.RequestLifecycle;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            var callerToken = context.HttpContext.RequestAborted;
            using var deadlineSource = new CancellationTokenSource(PlatformConstants.RequestDeadline, _timeProvider);
            using var linkedSource = CancellationTokenSource.CreateLinkedTokenSource(callerToken, deadlineSource.Token);
            var lifecycle = new PlatformRequestLifecycleState(callerToken, deadlineSource);
            var originalToken = context.HttpContext.RequestAborted;

            context.HttpContext.Items[PlatformRequestLifecycleState.ItemKey] = lifecycle;
            context.HttpContext.RequestAborted = linkedSource.Token;

            try
            {
                await next().ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (callerToken.IsCancellationRequested)
            {
                context.HttpContext.RequestAborted = callerToken;
                // A disconnected caller receives no attempted write and this is not a
                // server failure. The caller token intentionally wins a simultaneous race.
            }
            finally
            {
                context.HttpContext.RequestAborted = originalToken;
                context.HttpContext.Items.Remove(PlatformRequestLifecycleState.ItemKey);
            }
        }

        /// <inheritdoc />
        public async Task OnActionExecutionAsync(ActionExecutingContext context, ActionExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            if (!PlatformRequestLifecycleState.TryGet(context.HttpContext, out var lifecycle))
            {
                await next().ConfigureAwait(false);
                return;
            }

            try
            {
                var executed = await next().ConfigureAwait(false);
                if (lifecycle.CallerToken.IsCancellationRequested)
                {
                    executed.Result = new Microsoft.AspNetCore.Mvc.EmptyResult();
                    if (executed.Exception is OperationCanceledException)
                    {
                        executed.ExceptionHandled = true;
                    }

                    return;
                }

                if (lifecycle.DeadlineToken.IsCancellationRequested
                    && (executed.Exception is null || executed.Exception is OperationCanceledException)
                    && !context.HttpContext.Response.HasStarted)
                {
                    if (executed.Exception is OperationCanceledException)
                    {
                        executed.ExceptionHandled = true;
                    }

                    executed.Result = TimeoutResult(context.HttpContext);
                }
            }
            finally
            {
                // The deadline contains model binding and action execution, not result
                // serialization. Leaving a canceled linked token installed would prevent
                // the selected 504 envelope from being written at all.
                context.HttpContext.RequestAborted = lifecycle.CallerToken;
                lifecycle.StopDeadline();
            }
        }

        /// <inheritdoc />
        public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            if (!PlatformRequestLifecycleState.TryGet(context.HttpContext, out var lifecycle))
            {
                await next().ConfigureAwait(false);
                return;
            }

            // Result serialization is outside the kernel deadline and remains cancelable
            // only by the caller. This also covers model-state short circuits that never
            // entered the lifecycle action filter.
            context.HttpContext.RequestAborted = lifecycle.CallerToken;
            lifecycle.StopDeadline();

            if (lifecycle.CallerToken.IsCancellationRequested)
            {
                context.Cancel = true;
                return;
            }

            if (lifecycle.DeadlineToken.IsCancellationRequested
                && !context.HttpContext.Response.HasStarted)
            {
                context.Result = TimeoutResult(context.HttpContext);
            }
            else if (lifecycle.DeadlineToken.IsCancellationRequested)
            {
                context.Cancel = true;
                return;
            }

            await next().ConfigureAwait(false);
        }

        private static Microsoft.AspNetCore.Mvc.ObjectResult TimeoutResult(HttpContext httpContext)
        {
            var correlationId = PlatformCorrelation.For(httpContext);
            httpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
            return PlatformResults.Error(
                PlatformErrorCode.Timeout,
                "The request exceeded the Platform v1 deadline.",
                correlationId);
        }
    }

    /// <summary>Typed lifecycle state shared only by the Platform filter pipeline.</summary>
    internal sealed class PlatformRequestLifecycleState
    {
        private readonly CancellationTokenSource? _deadlineSource;

        internal static readonly object ItemKey = new();

        internal PlatformRequestLifecycleState(CancellationToken callerToken, CancellationToken deadlineToken)
        {
            CallerToken = callerToken;
            DeadlineToken = deadlineToken;
        }

        internal PlatformRequestLifecycleState(CancellationToken callerToken, CancellationTokenSource deadlineSource)
            : this(callerToken, deadlineSource.Token)
        {
            _deadlineSource = deadlineSource;
        }

        internal CancellationToken CallerToken { get; }

        internal CancellationToken DeadlineToken { get; }

        internal void StopDeadline() => _deadlineSource?.CancelAfter(Timeout.InfiniteTimeSpan);

        internal static bool TryGet(HttpContext context, out PlatformRequestLifecycleState lifecycle)
        {
            if (context.Items.TryGetValue(ItemKey, out var candidate)
                && candidate is PlatformRequestLifecycleState typed)
            {
                lifecycle = typed;
                return true;
            }

            lifecycle = null!;
            return false;
        }
    }
}
