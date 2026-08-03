using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Refuses requests that exclude the Platform JSON response representation.</summary>
    public sealed class PlatformAcceptMediaTypeFilter : IAsyncResourceFilter, IOrderedFilter
    {
        internal const int MaximumAcceptHeaderValues = 16;
        internal const int MaximumAcceptHeaderCharacters = 4096;
        internal const int MaximumAcceptMediaRanges = 32;

        /// <inheritdoc />
        public int Order => PlatformFilterOrder.AcceptMediaType;

        /// <inheritdoc />
        public async Task OnResourceExecutionAsync(ResourceExecutingContext context, ResourceExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            if (AcceptsJson(context.HttpContext.Request.Headers.Accept))
            {
                await next().ConfigureAwait(false);
                return;
            }

            var correlationId = PlatformCorrelation.For(context.HttpContext);
            context.HttpContext.Response.Headers[PlatformCorrelation.HeaderName] = correlationId;
            context.Result = PlatformResults.Error(
                PlatformErrorCode.NotAcceptable,
                "Platform responses are available only as application/json.",
                correlationId);
        }

        internal static bool AcceptsJson(StringValues header)
        {
            if (header.Count == 0)
            {
                return true;
            }

            if (header.Count > MaximumAcceptHeaderValues)
            {
                return false;
            }

            var values = header.Where(value => value is not null).Select(value => value!).ToArray();
            if (values.Length != header.Count
                || values.Any(value => value.Length == 0)
                || !IsWithinCharacterBound(values)
                || !MediaTypeHeaderValue.TryParseStrictList(values, out var parsed)
                || parsed.Count == 0
                || parsed.Count > MaximumAcceptMediaRanges
                || parsed.Any(HasInvalidQuality))
            {
                return false;
            }

            var matches = parsed
                .Select(candidate => TryMatchJsonRepresentation(candidate))
                .Where(match => match is not null)
                .Select(match => match!.Value)
                .ToList();
            if (matches.Count == 0)
            {
                return false;
            }

            var greatestTypeSpecificity = matches.Max(match => match.TypeSpecificity);
            var greatestParameterSpecificity = matches
                .Where(match => match.TypeSpecificity == greatestTypeSpecificity)
                .Max(match => match.ParameterSpecificity);
            return matches.Any(match =>
                match.TypeSpecificity == greatestTypeSpecificity
                && match.ParameterSpecificity == greatestParameterSpecificity
                && (match.Candidate.Quality ?? 1D) > 0D);
        }

        private static (MediaTypeHeaderValue Candidate, int TypeSpecificity, int ParameterSpecificity)?
            TryMatchJsonRepresentation(MediaTypeHeaderValue candidate)
        {
            if (!candidate.MatchesMediaType("application/json"))
            {
                return null;
            }

            var qualitySeen = false;
            var matchingRepresentationParameters = 0;
            foreach (var parameter in candidate.Parameters)
            {
                if (string.Equals(parameter.Name.Value, "q", StringComparison.OrdinalIgnoreCase))
                {
                    qualitySeen = true;
                    continue;
                }

                if (qualitySeen)
                {
                    // Accept extensions follow q and do not constrain the representation.
                    continue;
                }

                // Platform emits bare application/json with no representation parameters.
                // A media-range parameter before q therefore cannot match it.
                return null;
            }

            var typeSpecificity = candidate.MatchesAllTypes
                ? 0
                : candidate.MatchesAllSubTypes
                    ? 1
                    : 2;
            return (candidate, typeSpecificity, matchingRepresentationParameters);
        }

        private static bool HasInvalidQuality(MediaTypeHeaderValue candidate)
        {
            var qualityParameters = candidate.Parameters.Count(parameter =>
                string.Equals(parameter.Name.Value, "q", StringComparison.OrdinalIgnoreCase));
            return qualityParameters > 1 || (qualityParameters == 1 && candidate.Quality is null);
        }

        private static bool IsWithinCharacterBound(IReadOnlyList<string> values)
        {
            var characters = values.Count - 1;
            foreach (var value in values)
            {
                if (value.Length > MaximumAcceptHeaderCharacters - characters)
                {
                    return false;
                }

                characters += value.Length;
            }

            return true;
        }
    }
}
