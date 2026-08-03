using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Marks a Platform GET whose successful representation has a validator.</summary>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
    public sealed class PlatformCacheableAttribute : Attribute
    {
    }

    /// <summary>
    /// Marks a successful Platform representation that receives a strong validator
    /// without acquiring GET cache or conditional-request semantics.
    /// </summary>
    /// <remarks>
    /// Item-detail resolve is a POST because its bounded client capabilities are part
    /// of the representation key. Its ETag still names the exact returned bytes, but a
    /// matching <c>If-None-Match</c> must never turn that POST into a bodyless 304.
    /// </remarks>
    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
    public sealed class PlatformValidatedRepresentationAttribute : Attribute
    {
    }

    /// <summary>The result of evaluating one conditional request header.</summary>
    internal enum PlatformPreconditionDecision
    {
        Continue,
        NotModified,
        Failed,
        Invalid,
    }

    /// <summary>
    /// Owns Platform representation validators and RFC conditional comparison.
    /// </summary>
    /// <remarks>
    /// Validator creation always hashes the exact Platform JSON response bytes. Header
    /// parsing is bounded to 16 field values, 4,096 combined characters and 32 entity
    /// tags per conditional header. These limits are below the host header ceiling and
    /// make parser work independent of a proxy's own limits.
    ///
    /// Mutations must call <see cref="EvaluateIfMatch"/> against bytes for the current
    /// state while holding the resource owner's lock, and commit before releasing that
    /// lock. This result filter is sufficient for immutable GET representations only;
    /// evaluating an HTTP precondition before entering a mutation lock would introduce
    /// a check-then-write race.
    /// </remarks>
    public sealed class PlatformConcurrency : IAsyncResultFilter
    {
        internal const int MaximumConditionalHeaderValues = 16;
        internal const int MaximumConditionalHeaderCharacters = 4096;
        internal const int MaximumConditionalEntityTags = 32;

        /// <inheritdoc />
        public async Task OnResultExecutionAsync(ResultExecutingContext context, ResultExecutionDelegate next)
        {
            ArgumentNullException.ThrowIfNull(context);
            ArgumentNullException.ThrowIfNull(next);

            var cacheable = IsCacheableAction(context.ActionDescriptor);
            var validated = IsValidatedRepresentationAction(context.ActionDescriptor);
            if ((!cacheable && !validated)
                || context.Result is not PlatformJsonBodyResult { StatusCode: StatusCodes.Status200OK } result)
            {
                await next().ConfigureAwait(false);
                return;
            }

            var entityTag = CreateStrongEntityTag(result.Body);
            if (validated && !cacheable)
            {
                context.HttpContext.Response.GetTypedHeaders().ETag = entityTag;
                await next().ConfigureAwait(false);
                return;
            }

            var ifMatch = EvaluateIfMatch(context.HttpContext.Request.Headers.IfMatch, entityTag);
            if (ifMatch == PlatformPreconditionDecision.Invalid)
            {
                context.Result = PlatformJsonBodyResult.Create(
                    PlatformResults.Error(
                        PlatformErrorCode.InvalidRequest,
                        "If-Match must contain a bounded, valid entity-tag list.",
                        PlatformCorrelation.For(context.HttpContext)).Value!,
                    StatusCodes.Status400BadRequest);
                await next().ConfigureAwait(false);
                return;
            }

            if (ifMatch == PlatformPreconditionDecision.Failed)
            {
                context.HttpContext.Response.GetTypedHeaders().ETag = entityTag;
                context.Result = PlatformJsonBodyResult.Create(
                    PlatformResults.Error(
                        PlatformErrorCode.PreconditionFailed,
                        "The supplied representation validator does not match the current representation.",
                        PlatformCorrelation.For(context.HttpContext)).Value!,
                    StatusCodes.Status412PreconditionFailed);
                await next().ConfigureAwait(false);
                return;
            }

            var ifNoneMatch = EvaluateIfNoneMatch(context.HttpContext.Request.Headers.IfNoneMatch, entityTag);
            if (ifNoneMatch == PlatformPreconditionDecision.Invalid)
            {
                context.Result = PlatformJsonBodyResult.Create(
                    PlatformResults.Error(
                        PlatformErrorCode.InvalidRequest,
                        "If-None-Match must contain a bounded, valid entity-tag list.",
                        PlatformCorrelation.For(context.HttpContext)).Value!,
                    StatusCodes.Status400BadRequest);
                await next().ConfigureAwait(false);
                return;
            }

            context.HttpContext.Response.GetTypedHeaders().ETag = entityTag;

            if (ifNoneMatch == PlatformPreconditionDecision.NotModified)
            {
                context.HttpContext.Response.StatusCode = StatusCodes.Status304NotModified;
                context.Result = new Microsoft.AspNetCore.Mvc.EmptyResult();
            }

            await next().ConfigureAwait(false);
        }

        /// <summary>Creates one strong, quoted SHA-256 validator for exact response bytes.</summary>
        internal static EntityTagHeaderValue CreateStrongEntityTag(ReadOnlySpan<byte> representation)
        {
            var hash = Convert.ToHexString(SHA256.HashData(representation)).ToLowerInvariant();
            return new EntityTagHeaderValue(new Microsoft.Extensions.Primitives.StringSegment($"\"sha256-{hash}\""));
        }

        /// <summary>
        /// Strongly evaluates If-Match. Mutation owners call this inside their state lock.
        /// </summary>
        internal static PlatformPreconditionDecision EvaluateIfMatch(
            StringValues header,
            EntityTagHeaderValue current)
        {
            ArgumentNullException.ThrowIfNull(current);
            var parsed = Parse(header);
            if (parsed.Invalid)
            {
                return PlatformPreconditionDecision.Invalid;
            }

            if (!parsed.Present)
            {
                return PlatformPreconditionDecision.Continue;
            }

            return parsed.Values.Any(candidate =>
                candidate.Equals(EntityTagHeaderValue.Any)
                || candidate.Compare(current, useStrongComparison: true))
                ? PlatformPreconditionDecision.Continue
                : PlatformPreconditionDecision.Failed;
        }

        /// <summary>Weakly evaluates If-None-Match for a GET representation.</summary>
        internal static PlatformPreconditionDecision EvaluateIfNoneMatch(
            StringValues header,
            EntityTagHeaderValue current)
        {
            ArgumentNullException.ThrowIfNull(current);
            var parsed = Parse(header);
            if (parsed.Invalid)
            {
                return PlatformPreconditionDecision.Invalid;
            }

            if (!parsed.Present)
            {
                return PlatformPreconditionDecision.Continue;
            }

            return parsed.Values.Any(candidate =>
                candidate.Equals(EntityTagHeaderValue.Any)
                || candidate.Compare(current, useStrongComparison: false))
                ? PlatformPreconditionDecision.NotModified
                : PlatformPreconditionDecision.Continue;
        }

        private static bool IsCacheableAction(ActionDescriptor descriptor) =>
            descriptor is ControllerActionDescriptor controller
            && controller.MethodInfo.IsDefined(typeof(PlatformCacheableAttribute), inherit: true);

        private static bool IsValidatedRepresentationAction(ActionDescriptor descriptor) =>
            descriptor is ControllerActionDescriptor controller
            && controller.MethodInfo.IsDefined(typeof(PlatformValidatedRepresentationAttribute), inherit: true);

        private static ParsedEntityTags Parse(StringValues header)
        {
            if (header.Count == 0)
            {
                return ParsedEntityTags.Absent;
            }

            if (header.Count > MaximumConditionalHeaderValues)
            {
                return ParsedEntityTags.Malformed;
            }

            var values = header.Where(value => value is not null).Select(value => value!).ToArray();
            if (values.Length != header.Count
                || values.Any(value => value.Length == 0)
                || !IsWithinCharacterBound(values)
                || !EntityTagHeaderValue.TryParseList(values, out var parsed)
                || parsed.Count == 0
                || parsed.Count > MaximumConditionalEntityTags
                || (parsed.Any(value => value.Equals(EntityTagHeaderValue.Any)) && parsed.Count != 1))
            {
                return ParsedEntityTags.Malformed;
            }

            return new ParsedEntityTags(true, false, parsed);
        }

        private static bool IsWithinCharacterBound(IReadOnlyList<string> values)
        {
            var characters = values.Count - 1;
            foreach (var value in values)
            {
                if (value.Length > MaximumConditionalHeaderCharacters - characters)
                {
                    return false;
                }

                characters += value.Length;
            }

            return true;
        }

        private readonly record struct ParsedEntityTags(
            bool Present,
            bool Invalid,
            IList<EntityTagHeaderValue> Values)
        {
            internal static ParsedEntityTags Absent { get; } = new(false, false, Array.Empty<EntityTagHeaderValue>());

            internal static ParsedEntityTags Malformed { get; } = new(true, true, Array.Empty<EntityTagHeaderValue>());
        }
    }
}
