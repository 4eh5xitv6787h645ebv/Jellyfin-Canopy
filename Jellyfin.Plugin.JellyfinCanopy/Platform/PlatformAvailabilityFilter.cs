using System;
using System.Linq;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Marks the one anonymous request that reports Platform availability.</summary>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
    public sealed class PlatformDiscoveryProbeAttribute : Attribute
    {
    }

    /// <summary>
    /// Snapshots the live Platform master switch after first-party actor authorization
    /// and before media-type inspection or body acquisition.
    /// </summary>
    public sealed class PlatformAvailabilityFilter : IAsyncResourceFilter, IOrderedFilter
    {
        private static readonly object AvailabilityItemsKey = new();
        private const string DisabledMessage = "The native platform is currently disabled.";

        private readonly IPluginConfigProvider _configuration;
        private readonly ILogger<PlatformAvailabilityFilter> _logger;

        /// <summary>Initializes a request-scoped live availability boundary.</summary>
        public PlatformAvailabilityFilter(
            IPluginConfigProvider configuration,
            ILogger<PlatformAvailabilityFilter> logger)
        {
            _configuration = configuration ?? throw new ArgumentNullException(nameof(configuration));
            _logger = logger ?? throw new ArgumentNullException(nameof(logger));
        }

        /// <inheritdoc />
        public int Order => PlatformFilterOrder.Availability;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            var correlationId = PlatformCorrelation.For(context.HttpContext);
            var enabled = ReadEnabled(correlationId);
            Record(context.HttpContext, enabled);
            var discoveryProbe = context.ActionDescriptor.EndpointMetadata
                .Any(metadata => metadata is PlatformDiscoveryProbeAttribute);

            if (discoveryProbe)
            {
                if (!enabled)
                {
                    context.HttpContext.Response.Headers.CacheControl = "no-store";
                }

                await next().ConfigureAwait(false);
                return;
            }

            if (enabled)
            {
                await next().ConfigureAwait(false);
                return;
            }

            // This resource-filter rejection runs before the action exception filter,
            // so it owns the safe envelope, correlation header, and cache policy here.
            context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            context.Result = PlatformResults.Error(
                PlatformErrorCode.Unavailable,
                DisabledMessage,
                correlationId);
        }

        /// <summary>Returns the request-bound decision; missing state fails closed.</summary>
        internal static bool IsEnabled(HttpContext context)
        {
            ArgumentNullException.ThrowIfNull(context);
            return context.Items.TryGetValue(AvailabilityItemsKey, out var value)
                && value is true;
        }

        internal static void Record(HttpContext context, bool enabled)
        {
            ArgumentNullException.ThrowIfNull(context);
            context.Items[AvailabilityItemsKey] = enabled;
        }

        private bool ReadEnabled(string correlationId)
        {
            try
            {
                return _configuration.GetSnapshot().Configuration?.PlatformEnabled == true;
            }
            catch (Exception error)
            {
                // Resource-filter exceptions bypass PlatformRequestFilter. Treat a
                // broken provider exactly like absent configuration and keep detail
                // only in server logs.
                _logger.LogWarning(
                    error,
                    "Platform availability read failed; disabling Platform v1 for request {CorrelationId}.",
                    correlationId);
                return false;
            }
        }
    }
}
