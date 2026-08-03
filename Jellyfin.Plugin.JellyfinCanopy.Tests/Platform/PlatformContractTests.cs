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
        [InlineData(nameof(PlatformItemDetailResolveResponse), typeof(PlatformItemDetailResolveResponse))]
        [InlineData(nameof(PlatformNativeContribution), typeof(PlatformNativeContribution))]
        [InlineData(nameof(PlatformActionPrepareResponse), typeof(PlatformActionPrepareResponse))]
        [InlineData(nameof(PlatformNativeField), typeof(PlatformNativeField))]
        [InlineData(nameof(PlatformNativeOption), typeof(PlatformNativeOption))]
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

        [Fact]
        public void IdempotencyHeaderContractMatchesTheSharedParserBounds()
        {
            var parameter = Spec.RootElement.GetProperty("components").GetProperty("parameters")
                .GetProperty("IdempotencyKey");
            var schema = parameter.GetProperty("schema");

            Assert.Equal(PlatformIdempotencyKey.HeaderName, parameter.GetProperty("name").GetString());
            Assert.Equal("header", parameter.GetProperty("in").GetString());
            Assert.True(parameter.GetProperty("required").GetBoolean());
            Assert.Equal(1, schema.GetProperty("minLength").GetInt32());
            Assert.Equal(PlatformIdempotencyKey.MaximumLength, schema.GetProperty("maxLength").GetInt32());
            Assert.Equal("^[A-Za-z0-9._~-]+$", schema.GetProperty("pattern").GetString());

            Assert.True(PlatformIdempotencyKey.TryParse(new string('a', schema.GetProperty("maxLength").GetInt32()), out _));
            Assert.False(PlatformIdempotencyKey.TryParse(new string('a', schema.GetProperty("maxLength").GetInt32() + 1), out _));
        }

        [Fact]
        public void NativeInvokeBodyIdempotencyContractMatchesTheSharedParserBounds()
        {
            var schema = Spec.RootElement.GetProperty("components").GetProperty("schemas")
                .GetProperty("PlatformActionInvokeRequest").GetProperty("properties")
                .GetProperty("IdempotencyKey");

            Assert.Equal(1, schema.GetProperty("minLength").GetInt32());
            Assert.Equal(PlatformIdempotencyKey.MaximumLength, schema.GetProperty("maxLength").GetInt32());
            Assert.Equal("^[A-Za-z0-9._~-]+$", schema.GetProperty("pattern").GetString());

            var operation = Spec.RootElement.GetProperty("paths")
                .GetProperty("/JellyfinCanopy/Platform/v1/actions/invoke")
                .GetProperty("post");
            Assert.False(operation.TryGetProperty("parameters", out var parameters)
                && parameters.EnumerateArray().Any(parameter =>
                    parameter.TryGetProperty("$ref", out var reference)
                    && reference.GetString() == "#/components/parameters/IdempotencyKey"));
        }

        [Fact]
        public void NativeCatalogSchemaPinsTheReviewedCollectionBounds()
        {
            var schemas = Spec.RootElement.GetProperty("components").GetProperty("schemas");
            Assert.Equal(
                PlatformNativeCatalogBounds.MaximumContributions,
                schemas.GetProperty("PlatformItemDetailResolveResponse")
                    .GetProperty("properties").GetProperty("Contributions")
                    .GetProperty("maxItems").GetInt32());
            Assert.Equal(
                PlatformNativeCatalogBounds.MaximumFields,
                schemas.GetProperty("PlatformActionPrepareResponse")
                    .GetProperty("properties").GetProperty("Fields")
                    .GetProperty("maxItems").GetInt32());
            Assert.Equal(
                PlatformNativeCatalogBounds.MaximumOptions,
                schemas.GetProperty("PlatformNativeField")
                    .GetProperty("properties").GetProperty("Options")
                    .GetProperty("maxItems").GetInt32());
            Assert.Equal(
                PlatformActionInvokeRequestConverter.MaximumAnswers,
                schemas.GetProperty("PlatformActionInvokeRequest")
                    .GetProperty("properties").GetProperty("Answers")
                    .GetProperty("maxItems").GetInt32());
        }

        [Fact]
        public void EveryPlatformOperationDocumentsTheKernelTimeoutResponse()
        {
            var timeout = Spec.RootElement.GetProperty("components").GetProperty("responses")
                .GetProperty("Timeout");
            Assert.Equal(
                "#/components/schemas/PlatformError",
                timeout.GetProperty("content").GetProperty("application/json")
                    .GetProperty("schema").GetProperty("$ref").GetString());

            Assert.All(SpecOperations(), operation => Assert.Equal(
                "#/components/responses/Timeout",
                operation.Operation.GetProperty("responses").GetProperty("504").GetProperty("$ref").GetString()));
        }

        [Fact]
        public void CacheableOperationsDocumentValidatorsAlongsideKernelFailures()
        {
            var cacheable = LiveRoutes()
                .Where(route => route.Action.GetCustomAttribute<PlatformCacheableAttribute>() is not null)
                .ToList();
            Assert.NotEmpty(cacheable);
            Assert.All(cacheable, route => Assert.Equal("get", route.Method));

            var liveCacheable = cacheable
                .Select(route => $"{route.Method} {route.Path}")
                .OrderBy(route => route, StringComparer.Ordinal);
            var documentedCacheable = SpecOperations()
                .Where(entry => !entry.Operation.TryGetProperty(
                    "x-canopy-validated-representation",
                    out var validated)
                    || !validated.GetBoolean())
                .Where(entry => entry.Operation.GetProperty("responses").GetProperty("200")
                    .TryGetProperty("headers", out var headers)
                    && headers.TryGetProperty("ETag", out _))
                .Select(entry => $"{entry.Method} {entry.Path}")
                .OrderBy(route => route, StringComparer.Ordinal);
            Assert.Equal(liveCacheable, documentedCacheable);

            foreach (var route in cacheable)
            {
                var operation = SpecOperations().Single(entry =>
                    string.Equals(entry.Path, route.Path, StringComparison.Ordinal)
                    && string.Equals(entry.Method, route.Method, StringComparison.Ordinal)).Operation;
                var responses = operation.GetProperty("responses");
                var conditionalParameters = operation.GetProperty("parameters")
                    .EnumerateArray()
                    .Where(parameter => parameter.TryGetProperty("$ref", out _))
                    .Select(parameter => parameter.GetProperty("$ref").GetString()!)
                    .Where(reference => reference.StartsWith(
                        "#/components/parameters/If",
                        StringComparison.Ordinal))
                    .ToArray();

                Assert.Equal(
                    new[] { "#/components/parameters/IfMatch", "#/components/parameters/IfNoneMatch" },
                    conditionalParameters);
                Assert.Equal(
                    "#/components/headers/PlatformEntityTag",
                    responses.GetProperty("200").GetProperty("headers")
                        .GetProperty("ETag").GetProperty("$ref").GetString());
                Assert.Equal("#/components/responses/NotModified", responses.GetProperty("304").GetProperty("$ref").GetString());
                Assert.Equal("#/components/responses/InvalidConditionalRequest", responses.GetProperty("400").GetProperty("$ref").GetString());
                Assert.Equal("#/components/responses/PreconditionFailed", responses.GetProperty("412").GetProperty("$ref").GetString());
                Assert.Equal("#/components/responses/Timeout", responses.GetProperty("504").GetProperty("$ref").GetString());
            }

            // #522's future mutation components must remain in the same additive
            // document when conditional GET support grows it.
            var components = Spec.RootElement.GetProperty("components").GetProperty("responses");
            Assert.True(components.TryGetProperty("IdempotencyConflict", out _));
            Assert.True(components.TryGetProperty("IdempotencyAtCapacity", out _));
        }

        [Fact]
        public void ValidatedPostRepresentationsDocumentExactByteValidatorsWithoutGetSemantics()
        {
            var validated = LiveRoutes()
                .Where(route => route.Action.GetCustomAttribute<PlatformValidatedRepresentationAttribute>() is not null)
                .ToList();
            Assert.NotEmpty(validated);
            Assert.All(validated, route => Assert.Equal("post", route.Method));

            var liveValidated = validated
                .Select(route => $"{route.Method} {route.Path}")
                .OrderBy(route => route, StringComparer.Ordinal);
            var documentedValidated = SpecOperations()
                .Where(entry => entry.Operation.TryGetProperty(
                    "x-canopy-validated-representation",
                    out var marker)
                    && marker.GetBoolean())
                .Select(entry => $"{entry.Method} {entry.Path}")
                .OrderBy(route => route, StringComparer.Ordinal);
            Assert.Equal(liveValidated, documentedValidated);

            foreach (var route in validated)
            {
                var operation = SpecOperations().Single(entry =>
                    string.Equals(entry.Path, route.Path, StringComparison.Ordinal)
                    && string.Equals(entry.Method, route.Method, StringComparison.Ordinal)).Operation;
                var responses = operation.GetProperty("responses");
                Assert.Equal(
                    "#/components/headers/PlatformEntityTag",
                    responses.GetProperty("200").GetProperty("headers")
                        .GetProperty("ETag").GetProperty("$ref").GetString());
                Assert.False(responses.TryGetProperty("304", out _));
                Assert.False(operation.TryGetProperty("parameters", out var parameters)
                    && parameters.EnumerateArray().Any(parameter =>
                        parameter.TryGetProperty("$ref", out var reference)
                        && reference.GetString()!.StartsWith(
                            "#/components/parameters/If",
                            StringComparison.Ordinal)));
            }
        }

        [Theory]
        [InlineData("IdempotencyConflict")]
        [InlineData("IdempotencyAtCapacity")]
        public void FutureIdempotencyErrorsReuseThePlatformEnvelope(string responseName)
        {
            var response = Spec.RootElement.GetProperty("components").GetProperty("responses")
                .GetProperty(responseName);

            Assert.Equal(
                "#/components/schemas/PlatformError",
                response.GetProperty("content").GetProperty("application/json")
                    .GetProperty("schema").GetProperty("$ref").GetString());
        }

        [Theory]
        [InlineData("discovery.200.json", typeof(PlatformDiscoveryResponse))]
        [InlineData("discovery.disabled.200.json", typeof(PlatformDiscoveryResponse))]
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
        public void EveryAuthenticatedPlatformOperationDocumentsTheAdministrativeUnavailableGate()
        {
            var unavailable = Spec.RootElement.GetProperty("components").GetProperty("responses")
                .GetProperty("Unavailable");
            Assert.Equal(
                "no-store",
                unavailable.GetProperty("headers").GetProperty("Cache-Control")
                    .GetProperty("schema").GetProperty("const").GetString());
            Assert.Equal(
                "^[0-9a-f]{32}$",
                unavailable.GetProperty("headers").GetProperty("X-Correlation-Id")
                    .GetProperty("schema").GetProperty("pattern").GetString());

            var authenticated = SpecOperations().Where(operation =>
                !operation.Operation.TryGetProperty("security", out var security)
                || security.GetArrayLength() != 0);

            Assert.All(authenticated, operation => Assert.Equal(
                "#/components/responses/Unavailable",
                operation.Operation.GetProperty("responses").GetProperty("503").GetProperty("$ref").GetString()));
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
        public void NativeInvokeFixturePinsTheExactAndroidSuccessShape()
        {
            using var fixture = JsonDocument.Parse(File.ReadAllText(ContractPath(
                Path.Combine("fixtures", "invoke.native-action.200.json"))));
            var root = fixture.RootElement;
            Assert.Equal("succeeded", root.GetProperty("Outcome").GetString());
            Assert.Equal("Item hidden", root.GetProperty("Message").GetProperty("Text").GetString());
            Assert.Equal("positive", root.GetProperty("Message").GetProperty("Tone").GetString());
            Assert.Equal(
                new[] { "jellyfin_item", "item_detail_surface" },
                root.GetProperty("Refresh").GetProperty("Targets")
                    .EnumerateArray().Select(value => value.GetString()));
            Assert.Equal(3, root.EnumerateObject().Count());
        }

        [Fact]
        public void NativeResolveFixtureMatchesTheRealServerSerializer()
        {
            var response = new PlatformItemDetailResolveResponse(
                "catalog-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                [
                    PlatformNativeContribution.Action(
                        "spoiler-guard-configure",
                        "Configure Spoiler Guard",
                        "Choose whether Canopy protects this item.",
                        "shield",
                        enabled: true,
                        "opaque-prepare-handle"),
                    PlatformNativeContribution.Status(
                        "seerr-status",
                        "Seerr: Standard pending",
                        "warning"),
                ]);

            AssertFixtureEqualsSerialized("resolve.item-detail.200.json", response);
        }

        [Fact]
        public void NativePrepareFixtureMatchesTheRealServerSerializer()
        {
            var response = new PlatformActionPrepareResponse(
                "opaque-invoke-capability",
                DateTimeOffset.Parse("2026-08-03T00:00:00Z"),
                "Configure Hidden Content",
                "Apply",
                "Cancel",
                [
                    PlatformNativeField.Boolean(
                        "hidden",
                        "Hide this item",
                        "Canopy applies this only to the selected filtering scope.",
                        required: true,
                        defaultChecked: false),
                    PlatformNativeField.SingleSelect(
                        "scope",
                        "Filtering scope",
                        null,
                        required: true,
                        [
                            new PlatformNativeOption("global", "Every enabled surface"),
                            new PlatformNativeOption("continue_watching", "Continue Watching"),
                        ],
                        "global"),
                ]);

            AssertFixtureEqualsSerialized("prepare.native-action.200.json", response);
        }

        private static void AssertFixtureEqualsSerialized<T>(string fixtureName, T value)
        {
            using var expected = JsonDocument.Parse(File.ReadAllText(ContractPath(
                Path.Combine("fixtures", fixtureName))));
            using var actual = JsonDocument.Parse(JsonSerializer.SerializeToUtf8Bytes(
                value,
                PlatformJson.SerializerOptions));
            Assert.True(
                JsonElement.DeepEquals(expected.RootElement, actual.RootElement),
                $"{fixtureName} does not match the exact Platform serializer output.\nExpected: "
                    + expected.RootElement + "\nActual: " + actual.RootElement);
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
