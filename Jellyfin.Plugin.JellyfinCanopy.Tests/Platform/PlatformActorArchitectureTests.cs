using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Dependency and source guards that keep request identity above the actor boundary.
    /// A convenient future refactor must not turn the actor back into a principal-shaped
    /// credential container or authorize from caller-shaped request metadata.
    /// </summary>
    public class PlatformActorArchitectureTests
    {
        private static readonly Regex ForbiddenActorProperty = new(
            "token|bearer|claim|principal|context|request|header|route|query|body|cookie|marker|ip",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static readonly Regex ForbiddenAuthorizationSource = new(
            @"RequestIdentityService|Jellyfin-Token|ClaimTypes\.Role|Request\.Headers|Request\.Query|Request\.RouteValues|RouteData|Request\.Body|Request\.Cookies|RemoteIpAddress",
            RegexOptions.Compiled);

        private static readonly Regex ActorReference = new(@"\bPlatformActor\b", RegexOptions.Compiled);

        private static readonly Regex ActorConstruction = new(
            @"\bnew\s+PlatformActor\s*\(",
            RegexOptions.Compiled);

        [Fact]
        public void ActorIsASealedImmutableDataOnlyAllowList()
        {
            var type = typeof(PlatformActor);

            Assert.True(type.IsSealed);
            Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));

            var properties = type.GetProperties(BindingFlags.Public | BindingFlags.Instance);
            Assert.Equal(
                new[] { "ClientName", "CorrelationId", "DeviceId", "IsElevated", "UserId" },
                properties.Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal));
            Assert.All(properties, property =>
            {
                Assert.True(property.CanRead);
                Assert.False(property.CanWrite);
                Assert.DoesNotMatch(ForbiddenActorProperty, property.Name);
            });

            Assert.Equal(typeof(Guid), type.GetProperty(nameof(PlatformActor.UserId))!.PropertyType);
            Assert.Equal(typeof(bool), type.GetProperty(nameof(PlatformActor.IsElevated))!.PropertyType);
            Assert.Equal(typeof(string), type.GetProperty(nameof(PlatformActor.CorrelationId))!.PropertyType);
            Assert.Equal(typeof(string), type.GetProperty(nameof(PlatformActor.ClientName))!.PropertyType);
            Assert.Equal(typeof(string), type.GetProperty(nameof(PlatformActor.DeviceId))!.PropertyType);
        }

        [Fact]
        public void ActorDependencyGraphContainsNoCredentialOrRequestObjects()
        {
            var forbidden = new[]
            {
                typeof(ClaimsPrincipal),
                typeof(ClaimsIdentity),
                typeof(Claim),
                typeof(HttpContext),
                typeof(HttpRequest),
                typeof(HttpResponse),
            };

            var exposed = typeof(PlatformActor)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Select(property => property.PropertyType)
                .Concat(typeof(PlatformActor)
                    .GetConstructors(BindingFlags.Instance | BindingFlags.NonPublic)
                    .SelectMany(constructor => constructor.GetParameters())
                    .Select(parameter => parameter.ParameterType))
                .Distinct()
                .ToList();

            Assert.DoesNotContain(exposed, type => forbidden.Any(candidate => candidate.IsAssignableFrom(type)));
            Assert.DoesNotContain(exposed, type => type == typeof(byte[]) || typeof(Delegate).IsAssignableFrom(type));
        }

        [Fact]
        public void BoundaryDoesNotConsultCallerShapedAuthorizationSources()
        {
            var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile("PlatformActorBoundaryFilter.cs")));

            Assert.DoesNotMatch(ForbiddenAuthorizationSource, source);
            Assert.Contains("Jellyfin-UserId", source, StringComparison.Ordinal);
            Assert.Contains("_host.Users.Find(userId)", source, StringComparison.Ordinal);

            // Prove the guard catches every prohibited source rather than passing due to
            // a typo or an empty pattern.
            foreach (var violation in new[]
            {
                "RequestIdentityService.Resolve()",
                "principal.FindFirst(\"Jellyfin-Token\")",
                "principal.FindFirst(ClaimTypes.Role)",
                "Request.Headers[\"X-Jellyfin-User-Id\"]",
                "Request.Query[\"userId\"]",
                "Request.RouteValues[\"userId\"]",
                "RouteData.Values[\"userId\"]",
                "Request.Body",
                "Request.Cookies[\"marker\"]",
                "RemoteIpAddress",
            })
            {
                Assert.Matches(ForbiddenAuthorizationSource, violation);
            }
        }

        [Fact]
        public void AnyDownstreamActorConsumerCannotDependOnRequestIdentity()
        {
            var boundaryFiles = new HashSet<string>(StringComparer.Ordinal)
            {
                "PlatformActorBoundaryFilter.cs",
                "PlatformControllerBase.cs",
            };
            var consumers = SourceFiles()
                .Where(file => ActorReference.IsMatch(
                    PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
                .Where(file => !boundaryFiles.Contains(Path.GetFileName(file)))
                .ToList();

            Assert.Contains(consumers, file => Path.GetFileName(file) == "PlatformActor.cs");

            var offenders = consumers
                .Where(file => ForbiddenAuthorizationSource.IsMatch(
                    PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
                .Select(Path.GetFileName)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "PlatformActor consumer(s) reached below the controller boundary for request identity: "
                + string.Join(", ", offenders));
        }

        [Fact]
        public void OnlyTheControllerBoundaryCanConstructAnActor()
        {
            var constructors = SourceFiles()
                .Where(file => ActorConstruction.IsMatch(
                    PlatformHostSeamTests.CodeOnly(File.ReadAllText(file))))
                .Select(Path.GetFileName)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            Assert.Equal(new[] { "PlatformActorBoundaryFilter.cs" }, constructors);

            Assert.Matches(
                ActorConstruction,
                "var forged = new PlatformActor(userId, true, correlation, client, device);");
            Assert.DoesNotMatch(
                ActorConstruction,
                "void Accept(PlatformActor actor) { }");
        }

        [Fact]
        public void EveryPlatformControllerCarriesTheActorBoundaryBeforeBodyAcquisition()
        {
            var attributes = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .ToDictionary(attribute => attribute.ImplementationType, attribute => attribute.Order);

            Assert.Contains(typeof(PlatformActorBoundaryFilter), attributes.Keys);
            Assert.Equal(PlatformFilterOrder.ActorBoundary, attributes[typeof(PlatformActorBoundaryFilter)]);
            Assert.Equal(PlatformFilterOrder.Availability, attributes[typeof(PlatformAvailabilityFilter)]);
            Assert.Equal(PlatformFilterOrder.JsonMediaType, attributes[typeof(PlatformJsonMediaTypeFilter)]);
            Assert.Equal(PlatformFilterOrder.BoundedBody, attributes[typeof(PlatformBoundedBodyFilter)]);
            Assert.Equal(PlatformFilterOrder.RequestLifecycle, attributes[typeof(PlatformRequestLifecycleFilter)]);
            Assert.Equal(PlatformFilterOrder.JsonResult, attributes[typeof(PlatformJsonResultFilter)]);
            Assert.Equal(PlatformFilterOrder.Deprecation, attributes[typeof(PlatformDeprecationFilter)]);
            Assert.Equal(PlatformFilterOrder.Concurrency, attributes[typeof(PlatformConcurrency)]);
            Assert.True(attributes[typeof(PlatformActorBoundaryFilter)] < attributes[typeof(PlatformAvailabilityFilter)]);
            Assert.True(attributes[typeof(PlatformAvailabilityFilter)] < attributes[typeof(PlatformJsonMediaTypeFilter)]);
            Assert.True(attributes[typeof(PlatformJsonMediaTypeFilter)] < attributes[typeof(PlatformBoundedBodyFilter)]);
            Assert.True(attributes[typeof(PlatformBoundedBodyFilter)] < attributes[typeof(PlatformRequestLifecycleFilter)]);
            Assert.True(attributes[typeof(PlatformRequestLifecycleFilter)] < attributes[typeof(PlatformDeprecationFilter)]);
            Assert.True(attributes[typeof(PlatformDeprecationFilter)] < attributes[typeof(PlatformJsonResultFilter)]);
            Assert.True(attributes[typeof(PlatformJsonResultFilter)] < attributes[typeof(PlatformConcurrency)]);
            Assert.Equal(PlatformFilterOrder.JsonMediaType, new PlatformJsonMediaTypeFilter().Order);
            Assert.Equal(PlatformFilterOrder.BoundedBody, new PlatformBoundedBodyFilter().Order);
            Assert.Equal(PlatformFilterOrder.RequestLifecycle, new PlatformRequestLifecycleFilter().Order);
            Assert.True(typeof(IAsyncResourceFilter).IsAssignableFrom(typeof(PlatformActorBoundaryFilter)));
            Assert.True(typeof(IAsyncResourceFilter).IsAssignableFrom(typeof(PlatformAvailabilityFilter)));
            Assert.False(typeof(IAsyncAuthorizationFilter).IsAssignableFrom(typeof(PlatformActorBoundaryFilter)));

            var controllers = typeof(PlatformControllerBase).Assembly
                .GetTypes()
                .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type));

            Assert.All(controllers, controller => Assert.Contains(
                controller.GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true).Cast<TypeFilterAttribute>(),
                attribute => attribute.ImplementationType == typeof(PlatformActorBoundaryFilter)));
            Assert.All(controllers, controller => Assert.Contains(
                controller.GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true).Cast<TypeFilterAttribute>(),
                attribute => attribute.ImplementationType == typeof(PlatformAvailabilityFilter)));
        }

        private static IEnumerable<string> SourceFiles()
            => Directory.EnumerateFiles(SourceRoot(), "*.cs", SearchOption.AllDirectories)
                .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal));

        private static string SourceFile(string name) => SourceFiles().Single(file => Path.GetFileName(file) == name);

        private static string SourceRoot([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "Platform"));
    }
}
