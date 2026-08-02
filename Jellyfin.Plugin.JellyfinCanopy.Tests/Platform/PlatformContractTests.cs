using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Routing;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// The CI drift gate for the Platform v1 contract (risk R-17).
    ///
    /// <para>
    /// There is currently no machine-readable description of the pre-platform API at all
    /// — no OpenAPI, no JSON Schema, no <c>[ProducesResponseType]</c> across 183 routes.
    /// The only description is prose that says itself it documents a subset. That is how
    /// a surface becomes unversionable.
    /// </para>
    /// <para>
    /// <b>The spec is authored, not generated.</b> Generating it from the running server
    /// would document whatever the code happens to do, mistakes included, and would make
    /// a breaking change undetectable — the spec would simply move with the bug. So the
    /// spec is the source of truth and these tests check the server against it, in both
    /// directions: a route with no spec entry fails, and a spec entry with no route fails.
    /// </para>
    /// </summary>
    public class PlatformContractTests
    {
        private static readonly JsonDocument Spec = JsonDocument.Parse(File.ReadAllText(ContractPath("openapi.json")));
        private static readonly JsonDocument Frozen = JsonDocument.Parse(File.ReadAllText(ContractPath("frozen.json")));

        private static string ContractPath(string name, [CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "contracts", "platform", "v1", name));

        private static IEnumerable<Type> PlatformControllers => typeof(PlatformControllerBase).Assembly
            .GetTypes()
            .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type));

        /// <summary>Every routable action, as the path and method it actually serves.</summary>
        private static IEnumerable<(string Path, string Method, MethodInfo Action)> LiveRoutes()
        {
            foreach (var controller in PlatformControllers)
            {
                var prefix = controller.GetCustomAttribute<RouteAttribute>()?.Template
                    ?? throw new InvalidOperationException($"{controller.Name} has no route prefix.");

                foreach (var action in controller.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
                {
                    if (action.IsSpecialName)
                    {
                        continue;
                    }

                    foreach (var verb in action.GetCustomAttributes<HttpMethodAttribute>())
                    {
                        var suffix = verb.Template;
                        var path = "/" + (string.IsNullOrEmpty(suffix) ? prefix : prefix + "/" + suffix);

                        yield return (path, verb.HttpMethods.First().ToLowerInvariant(), action);
                    }
                }
            }
        }

        /// <summary>
        /// A property's declared type as one canonical string.
        ///
        /// Compared as text rather than as raw JSON because the two documents are
        /// formatted differently, and <c>["integer","null"]</c> pretty-printed is not
        /// textually equal to the same array written compactly — which would report a
        /// breaking change that had not happened, training people to ignore the gate.
        /// The union is sorted so a reordering is not mistaken for a retype either.
        /// </summary>
        private static string TypeToken(JsonElement type) => type.ValueKind switch
        {
            JsonValueKind.Array => string.Join(
                "|",
                type.EnumerateArray().Select(value => value.GetString()).OrderBy(value => value, StringComparer.Ordinal)),
            _ => type.GetString() ?? string.Empty,
        };

        private static IEnumerable<(string Path, string Method, JsonElement Operation)> SpecOperations()
        {
            foreach (var path in Spec.RootElement.GetProperty("paths").EnumerateObject())
            {
                foreach (var operation in path.Value.EnumerateObject())
                {
                    yield return (path.Name, operation.Name, operation.Value);
                }
            }
        }

        [Fact]
        public void EveryLiveRouteIsDescribedBySpec()
        {
            var documented = SpecOperations().Select(entry => $"{entry.Method} {entry.Path}").ToHashSet(StringComparer.Ordinal);

            var undocumented = LiveRoutes()
                .Select(route => $"{route.Method} {route.Path}")
                .Where(route => !documented.Contains(route))
                .OrderBy(route => route, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                undocumented.Count == 0,
                "Platform v1 route(s) exist with no entry in contracts/platform/v1/openapi.json: "
                + string.Join(", ", undocumented) + ".\n"
                + "The spec is the contract. Add the route to it - including its responses and whether it "
                + "is anonymous - rather than shipping a route no consumer can discover.");
        }

        [Fact]
        public void EverySpecRouteStillExists()
        {
            // The other direction. A spec that describes routes the server no longer
            // serves is worse than no spec: a consumer generates a client against it and
            // gets a 404 at runtime.
            var live = LiveRoutes().Select(route => $"{route.Method} {route.Path}").ToHashSet(StringComparer.Ordinal);

            var stale = SpecOperations()
                .Select(entry => $"{entry.Method} {entry.Path}")
                .Where(entry => !live.Contains(entry))
                .OrderBy(entry => entry, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                stale.Count == 0,
                "contracts/platform/v1/openapi.json describes route(s) the server does not serve: "
                + string.Join(", ", stale) + ".");
        }

        [Fact]
        public void TheSpecAgreesWithTheServerAboutWhichRoutesAreAnonymous()
        {
            // A spec that claims a route needs authentication when it does not - or the
            // reverse - is worse than silence, because a consumer trusts it. In OpenAPI,
            // "security": [] on an operation means explicitly anonymous.
            var mismatches = new List<string>();

            foreach (var (path, method, action) in LiveRoutes())
            {
                var liveAnonymous = action.GetCustomAttribute<AllowAnonymousAttribute>() is not null
                    || action.DeclaringType!.GetCustomAttribute<AllowAnonymousAttribute>() is not null;

                var operation = SpecOperations().Single(entry =>
                    string.Equals(entry.Path, path, StringComparison.Ordinal)
                    && string.Equals(entry.Method, method, StringComparison.Ordinal)).Operation;

                var specAnonymous = operation.TryGetProperty("security", out var security)
                    && security.GetArrayLength() == 0;

                if (liveAnonymous != specAnonymous)
                {
                    mismatches.Add($"{method} {path} is {(liveAnonymous ? "anonymous" : "authenticated")} "
                        + $"but the spec says {(specAnonymous ? "anonymous" : "authenticated")}");
                }
            }

            Assert.True(mismatches.Count == 0, string.Join("; ", mismatches));
        }

        [Theory]
        [InlineData(nameof(PlatformDiscoveryResponse), typeof(PlatformDiscoveryResponse))]
        [InlineData(nameof(PlatformNegotiationResponse), typeof(PlatformNegotiationResponse))]
        [InlineData(nameof(PlatformError), typeof(PlatformError))]
        public void SchemasDoNotDriftFromTheTypesTheyDescribe(string schemaName, Type type)
        {
            var schema = Spec.RootElement.GetProperty("components").GetProperty("schemas").GetProperty(schemaName);

            var specProperties = schema.GetProperty("properties")
                .EnumerateObject()
                .Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            var liveProperties = type.GetProperties()
                .Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            Assert.Equal(liveProperties, specProperties);
        }

        [Fact]
        public void TheDocumentedErrorCodesAreExactlyTheOnesTheServerCanReturn()
        {
            var specCodes = Spec.RootElement
                .GetProperty("components").GetProperty("schemas")
                .GetProperty("PlatformErrorCode").GetProperty("enum")
                .EnumerateArray()
                .Select(code => code.GetString()!)
                .OrderBy(code => code, StringComparer.Ordinal);

            Assert.Equal(PlatformErrorCode.All.OrderBy(code => code, StringComparer.Ordinal), specCodes);
        }

        [Fact]
        public void TheDocumentedProtocolRangeMatchesTheServer()
        {
            var discovery = Spec.RootElement.GetProperty("components").GetProperty("schemas")
                .GetProperty("PlatformDiscoveryResponse");

            Assert.Contains(
                discovery.GetProperty("required").EnumerateArray(),
                required => required.GetString() == nameof(PlatformDiscoveryResponse.ProtocolMinimum));

            // The fixture is the documented example, so it has to agree with the server's
            // real range or the example teaches a consumer the wrong thing.
            var fixtureText = File.ReadAllText(ContractPath(Path.Combine("fixtures", "discovery.200.json")));
            var fixture = JsonSerializer.Deserialize<PlatformDiscoveryResponse>(fixtureText, PlatformJson.SerializerOptions)!;

            Assert.Equal(PlatformConstants.ProtocolMinimum, fixture.ProtocolMinimum);
            Assert.Equal(PlatformConstants.ProtocolMaximum, fixture.ProtocolMaximum);
        }

        [Theory]
        [InlineData("discovery.200.json", typeof(PlatformDiscoveryResponse))]
        [InlineData("negotiate.200.compatible.json", typeof(PlatformNegotiationResponse))]
        [InlineData("negotiate.200.incompatible.json", typeof(PlatformNegotiationResponse))]
        [InlineData("error.413.json", typeof(PlatformError))]
        public void GoldenFixturesRoundTripThroughTheRealTypesWithoutLosingAnything(string fixtureName, Type type)
        {
            // A fixture that cannot round-trip is a fixture that documents a shape the
            // server cannot actually produce - a stale example, which is exactly what
            // this gate is meant to catch.
            var original = File.ReadAllText(ContractPath(Path.Combine("fixtures", fixtureName)));

            var parsed = JsonSerializer.Deserialize(original, type, PlatformJson.SerializerOptions)!;
            var reserialized = JsonSerializer.Serialize(parsed, type, PlatformJson.SerializerOptions);

            using var before = JsonDocument.Parse(original);
            using var after = JsonDocument.Parse(reserialized);

            var beforeProperties = before.RootElement.EnumerateObject()
                .ToDictionary(property => property.Name, property => property.Value.ToString(), StringComparer.Ordinal);
            var afterProperties = after.RootElement.EnumerateObject()
                .ToDictionary(property => property.Name, property => property.Value.ToString(), StringComparer.Ordinal);

            Assert.Equal(beforeProperties, afterProperties);
        }

        [Fact]
        public void TheErrorFixtureUsesADocumentedCodeAndAConformingCorrelationId()
        {
            var error = JsonSerializer.Deserialize<PlatformError>(
                File.ReadAllText(ContractPath(Path.Combine("fixtures", "error.413.json"))),
                PlatformJson.SerializerOptions)!;

            Assert.True(PlatformErrorCode.IsKnown(error.Code));
            Assert.Equal(413, PlatformErrorCode.StatusFor(error.Code));
            Assert.Equal(error.Retryable, PlatformErrorCode.IsRetryable(error.Code));

            // The example must satisfy the pattern the spec advertises, or a consumer
            // validating against the spec rejects our own documentation.
            Assert.Matches("^[0-9a-f]{32}$", error.CorrelationId);
        }

        [Fact]
        public void NoPathOrMethodPublishedInV1HasBeenRemoved()
        {
            // ADR-0010: changes within v1 are additive only. Enforced here rather than
            // left to a reviewer noticing a deletion in a large diff.
            var live = SpecOperations()
                .Select(entry => $"{entry.Method} {entry.Path}")
                .ToHashSet(StringComparer.Ordinal);

            var removed = new List<string>();

            foreach (var path in Frozen.RootElement.GetProperty("paths").EnumerateObject())
            {
                foreach (var method in path.Value.EnumerateArray())
                {
                    var entry = $"{method.GetString()} {path.Name}";
                    if (!live.Contains(entry))
                    {
                        removed.Add(entry);
                    }
                }
            }

            Assert.True(
                removed.Count == 0,
                "Published Platform v1 route(s) were removed or renamed: " + string.Join(", ", removed) + ".\n"
                + "Within v1 the surface may only grow (ADR-0010). An incompatible change belongs in a v2 "
                + "route family, which can coexist, rather than mutating v1 under existing consumers.");
        }

        [Fact]
        public void NoRequiredPropertyPublishedInV1HasBeenRemovedOrRetyped()
        {
            var schemas = Spec.RootElement.GetProperty("components").GetProperty("schemas");
            var breaks = new List<string>();

            foreach (var frozenSchema in Frozen.RootElement.GetProperty("schemas").EnumerateObject())
            {
                if (!schemas.TryGetProperty(frozenSchema.Name, out var liveSchema))
                {
                    breaks.Add($"schema {frozenSchema.Name} was removed");
                    continue;
                }

                if (frozenSchema.Value.TryGetProperty("enum", out var frozenEnum))
                {
                    var liveValues = liveSchema.GetProperty("enum").EnumerateArray()
                        .Select(value => value.GetString()!)
                        .ToHashSet(StringComparer.Ordinal);

                    // Adding a code is additive; removing one breaks a consumer that
                    // branches on it.
                    breaks.AddRange(frozenEnum.EnumerateArray()
                        .Select(value => value.GetString()!)
                        .Where(value => !liveValues.Contains(value))
                        .Select(value => $"{frozenSchema.Name} no longer documents the value '{value}'"));
                    continue;
                }

                var liveRequired = liveSchema.GetProperty("required").EnumerateArray()
                    .Select(value => value.GetString()!)
                    .ToHashSet(StringComparer.Ordinal);

                breaks.AddRange(frozenSchema.Value.GetProperty("required").EnumerateArray()
                    .Select(value => value.GetString()!)
                    .Where(value => !liveRequired.Contains(value))
                    .Select(value => $"{frozenSchema.Name}.{value} is no longer required"));

                var liveProperties = liveSchema.GetProperty("properties");

                foreach (var frozenProperty in frozenSchema.Value.GetProperty("propertyTypes").EnumerateObject())
                {
                    if (!liveProperties.TryGetProperty(frozenProperty.Name, out var liveProperty))
                    {
                        breaks.Add($"{frozenSchema.Name}.{frozenProperty.Name} was removed");
                        continue;
                    }

                    var liveType = TypeToken(liveProperty.TryGetProperty("type", out var type)
                        ? type
                        : liveProperty.GetProperty("$ref"));
                    var frozenType = TypeToken(frozenProperty.Value);

                    if (!string.Equals(liveType, frozenType, StringComparison.Ordinal))
                    {
                        breaks.Add(
                            $"{frozenSchema.Name}.{frozenProperty.Name} changed type from "
                            + $"{frozenType} to {liveType}");
                    }
                }
            }

            Assert.True(
                breaks.Count == 0,
                "Breaking change(s) to published Platform v1 schemas: " + string.Join("; ", breaks) + ".\n"
                + "Within v1 the surface may only grow (ADR-0010). Do not edit frozen.json to make this "
                + "pass - that is the one thing it must never be used for.");
        }

        [Fact]
        public void TheFrozenSnapshotDescribesSomethingRatherThanBeingEmpty()
        {
            // A gate comparing against an empty snapshot passes unconditionally, which
            // looks identical to a gate that is working.
            Assert.NotEmpty(Frozen.RootElement.GetProperty("paths").EnumerateObject());
            Assert.NotEmpty(Frozen.RootElement.GetProperty("schemas").EnumerateObject());
        }
    }
}
