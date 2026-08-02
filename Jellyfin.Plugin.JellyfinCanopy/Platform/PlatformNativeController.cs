using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>The complete authenticated HTTP surface for the native item-detail pilot.</summary>
    [Route(PlatformConstants.RoutePrefix)]
    public sealed class PlatformNativeController : PlatformControllerBase
    {
        private readonly PlatformNativeCatalogService _catalog;
        private readonly PlatformActionInvocationCoordinator _invocations;

        /// <summary>Initializes the fixed native controller.</summary>
        public PlatformNativeController(
            PlatformNativeCatalogService catalog,
            PlatformActionInvocationCoordinator invocations)
        {
            _catalog = catalog ?? throw new ArgumentNullException(nameof(catalog));
            _invocations = invocations ?? throw new ArgumentNullException(nameof(invocations));
        }

        /// <summary>Resolves the current actor's bounded item-detail contributions.</summary>
        [HttpPost("surfaces/item-detail/resolve")]
        [PlatformValidatedRepresentation]
        public async Task<IActionResult> ResolveItemDetail(
            [FromBody] PlatformItemDetailResolveRequest request,
            CancellationToken cancellationToken)
        {
            var outcome = await _catalog.ResolveAsync(Actor, request, cancellationToken).ConfigureAwait(false);
            return outcome.Kind switch
            {
                PlatformNativeCatalogOutcomeKind.Success => Ok(outcome.Response),
                PlatformNativeCatalogOutcomeKind.UnsupportedProtocol =>
                    PlatformProblem(PlatformErrorCode.UnsupportedProtocol, "The requested native protocol or surface schema is unsupported."),
                PlatformNativeCatalogOutcomeKind.NotFound =>
                    PlatformProblem(PlatformErrorCode.NotFound, "The requested item is unavailable."),
                _ => PlatformProblem(PlatformErrorCode.Unavailable, "The native item-detail catalog is temporarily unavailable."),
            };
        }

        /// <summary>Re-authorizes one opaque catalog action and mints a short-lived capability.</summary>
        [HttpPost("actions/prepare")]
        public async Task<IActionResult> PrepareAction(
            [FromBody] PlatformActionPrepareRequest request,
            CancellationToken cancellationToken)
        {
            var outcome = await _catalog.PrepareAsync(Actor, request, cancellationToken).ConfigureAwait(false);
            return outcome.Kind switch
            {
                PlatformNativeCatalogOutcomeKind.Success => Ok(outcome.Response),
                PlatformNativeCatalogOutcomeKind.NotFound =>
                    PlatformProblem(PlatformErrorCode.NotFound, "The prepared action is unavailable."),
                _ => PlatformProblem(PlatformErrorCode.Unavailable, "The prepared action cannot be issued right now."),
            };
        }

        /// <summary>Invokes one body-carried opaque capability through the fixed coordinator.</summary>
        [HttpPost("actions/invoke")]
        public async Task<IActionResult> InvokeAction([FromBody] PlatformActionInvokeRequest request)
        {
            if (!PlatformActionIdempotencyCarrier.TryResolve(
                    request,
                    Request.Headers[PlatformIdempotencyKey.HeaderName],
                    out _))
            {
                return PlatformProblem(
                    PlatformErrorCode.InvalidRequest,
                    "IdempotencyKey must appear exactly once in the request body and not in a header.");
            }

            PlatformInvocationCancellation cancellation;
            if (PlatformRequestLifecycleState.TryGet(HttpContext, out var lifecycle))
            {
                cancellation = new PlatformInvocationCancellation(
                    HttpContext.RequestAborted,
                    lifecycle.CallerToken,
                    lifecycle.DeadlineToken);
            }
            else
            {
                cancellation = new PlatformInvocationCancellation(
                    HttpContext.RequestAborted,
                    HttpContext.RequestAborted,
                    CancellationToken.None);
            }

            var outcome = await _invocations.InvokeAsync(Actor, request, cancellation).ConfigureAwait(false);
            if (outcome.Result.StatusCode == 200)
            {
                return new ObjectResult(outcome.Result.Value) { StatusCode = 200 };
            }

            return PlatformProblem(outcome.Result.OutcomeCode, ErrorMessage(outcome.Result.OutcomeCode));
        }

        private static string ErrorMessage(string code) => code switch
        {
            PlatformErrorCode.InvalidRequest => "The action answers are invalid.",
            PlatformErrorCode.NotFound => "The action is unavailable or no longer authorized.",
            PlatformErrorCode.Conflict => "The action conflicts with newer state. Refresh and try again.",
            PlatformErrorCode.PayloadTooLarge => "The resulting state exceeds its fixed size limit.",
            PlatformErrorCode.RateLimited => "The action is temporarily rate limited.",
            PlatformErrorCode.Unavailable => "A required service is temporarily unavailable.",
            PlatformErrorCode.Timeout => "The action exceeded the Platform deadline.",
            _ => "The action could not be completed.",
        };
    }
}
