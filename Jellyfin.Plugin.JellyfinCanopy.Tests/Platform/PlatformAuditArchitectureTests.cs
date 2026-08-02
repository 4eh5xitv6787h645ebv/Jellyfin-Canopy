using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Security.Claims;
using System.Text.Json;
using System.Text.RegularExpressions;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Guards the audit allowlist, sole bounded owner and absent HTTP surface.</summary>
    public class PlatformAuditArchitectureTests
    {
        private static readonly Regex ForbiddenRecordName = new(
            "payload|token|bearer|capability|idempotencykey|request|body|title|url|upstream|response|message|exception|principal|context|itemid|provider",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static readonly Regex UnboundedAuditOwner = new(
            @"(?:Dictionary|ConcurrentDictionary|Queue|ConcurrentQueue|List|BoundedTtlCache)\s*<[^;\r\n]+>\s+_[A-Za-z_]\w*\s*(?:=|;)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        [Fact]
        public void TerminalRecordIsAnImmutableTypedAllowList()
        {
            var type = typeof(PlatformAuditRecord);
            var expected = new Dictionary<string, Type>(StringComparer.Ordinal)
            {
                ["ActorUserId"] = typeof(Guid),
                ["ActorWasElevated"] = typeof(bool),
                ["ClientAttributionDigest"] = typeof(string),
                ["CompletedAtUtc"] = typeof(DateTimeOffset),
                ["CorrelationId"] = typeof(string),
                ["Decision"] = typeof(PlatformAuditDecision),
                ["DeviceAttributionDigest"] = typeof(string),
                ["DurationMilliseconds"] = typeof(long),
                ["Family"] = typeof(PlatformOperationFamily?),
                ["Operation"] = typeof(PlatformOperationId?),
                ["ResultCode"] = typeof(PlatformAuditResultCode),
                ["StartedAtUtc"] = typeof(DateTimeOffset),
                ["SubjectResolution"] = typeof(PlatformAuditSubjectResolution),
            };

            Assert.True(type.IsSealed);
            Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
            Assert.Equal(
                expected,
                type.GetProperties(BindingFlags.NonPublic | BindingFlags.Instance)
                    .ToDictionary(property => property.Name, property => property.PropertyType, StringComparer.Ordinal));
            Assert.All(
                type.GetProperties(BindingFlags.NonPublic | BindingFlags.Instance),
                property => Assert.False(property.CanWrite));
            Assert.DoesNotContain(expected.Keys, name => ForbiddenRecordName.IsMatch(name));
            Assert.Equal(
                new[] { "ClientAttributionDigest", "CorrelationId", "DeviceAttributionDigest" },
                expected.Where(pair => pair.Value == typeof(string)).Select(pair => pair.Key).OrderBy(name => name, StringComparer.Ordinal));
        }

        [Fact]
        public void AuditTypesCannotCarryCredentialRequestOrFreeFormObjects()
        {
            var forbiddenTypes = new[]
            {
                typeof(object),
                typeof(byte[]),
                typeof(Exception),
                typeof(ClaimsPrincipal),
                typeof(ClaimsIdentity),
                typeof(Claim),
                typeof(HttpContext),
                typeof(HttpRequest),
                typeof(HttpResponse),
                typeof(JsonDocument),
                typeof(JsonElement),
            };
            var auditedTypes = new[]
            {
                typeof(PlatformAuditRecord),
                typeof(PlatformAuditHealthSnapshot),
            };

            foreach (var type in auditedTypes)
            {
                var exposed = type.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .Select(property => property.PropertyType)
                    .Concat(type.GetConstructors(BindingFlags.NonPublic | BindingFlags.Instance)
                        .SelectMany(constructor => constructor.GetParameters())
                        .Select(parameter => parameter.ParameterType));

                Assert.DoesNotContain(exposed, exposedType => forbiddenTypes.Any(forbidden =>
                    forbidden == exposedType
                    || (forbidden != typeof(object) && forbidden.IsAssignableFrom(exposedType))));
            }
        }

        [Fact]
        public void AuditStateHasOneFixedRingAndNoUnboundedCollectionOwner()
        {
            var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile("PlatformAuditStore.cs")));

            Assert.Contains("new PlatformAuditRecord?[MaximumRecords]", source, StringComparison.Ordinal);
            Assert.Contains("_nextIndex = (_nextIndex + 1) % MaximumRecords", source, StringComparison.Ordinal);
            Assert.DoesNotMatch(UnboundedAuditOwner, source);
            Assert.Equal(1024, PlatformAuditStore.MaximumRecords);

            const string planted = "private readonly Queue<PlatformAuditRecord> _auditRecords = new();";
            Assert.Matches(UnboundedAuditOwner, planted);
        }

        [Fact]
        public void AuditStoreExposesNeitherGlobalReadsNorAnyControllerDependency()
        {
            Assert.Empty(typeof(PlatformAuditStore)
                .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly));
            Assert.Empty(typeof(PlatformAuditStore)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly));

            var controllers = typeof(PlatformAuditStore).Assembly.GetTypes()
                .Where(type => typeof(ControllerBase).IsAssignableFrom(type))
                .ToList();

            Assert.NotEmpty(controllers);
            foreach (var controller in controllers)
            {
                var surfaceTypes = controller
                    .GetFields(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
                    .Select(field => field.FieldType)
                    .Concat(controller.GetProperties(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
                        .Select(property => property.PropertyType))
                    .Concat(controller.GetConstructors(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                        .SelectMany(constructor => constructor.GetParameters())
                        .Select(parameter => parameter.ParameterType))
                    .Concat(controller.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
                        .Select(method => method.ReturnType))
                    .Concat(controller.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static)
                        .SelectMany(method => method.GetParameters())
                        .Select(parameter => parameter.ParameterType));

                Assert.DoesNotContain(surfaceTypes, ContainsAuditStorageType);

                var sourceFiles = Directory.GetFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
                    .Where(file => File.ReadAllText(file).Contains($"class {controller.Name}", StringComparison.Ordinal))
                    .ToList();
                Assert.NotEmpty(sourceFiles);
                Assert.All(sourceFiles, file =>
                {
                    var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(file));
                    Assert.DoesNotContain(nameof(PlatformAuditStore), source, StringComparison.Ordinal);
                    Assert.DoesNotContain(nameof(PlatformAuditRecord), source, StringComparison.Ordinal);
                    Assert.DoesNotContain(nameof(PlatformAuditHealthSnapshot), source, StringComparison.Ordinal);
                });
            }
        }

        [Fact]
        public void CallerOperationTextHasNoAuditEntryPoint()
        {
            var beginMethods = typeof(PlatformAuditStore)
                .GetMethods(BindingFlags.NonPublic | BindingFlags.Instance)
                .Where(method => method.Name.StartsWith("Begin", StringComparison.Ordinal))
                .ToList();

            Assert.NotEmpty(beginMethods);
            Assert.DoesNotContain(beginMethods.SelectMany(method => method.GetParameters()), parameter => parameter.ParameterType == typeof(string));
            Assert.Contains(beginMethods, method => method.Name == "Begin"
                && method.GetParameters().Select(parameter => parameter.ParameterType)
                    .SequenceEqual(new[] { typeof(PlatformActor), typeof(PlatformOperationDefinition) }));
            Assert.Contains(beginMethods, method => method.Name == "BeginUnresolved"
                && method.GetParameters().Select(parameter => parameter.ParameterType)
                    .SequenceEqual(new[] { typeof(PlatformActor) }));
        }

        [Fact]
        public void AttributionIsReducedBeforeItCanEnterARecordOrLog()
        {
            var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile("PlatformAuditStore.cs")));
            var logStart = source.IndexOf("_logger.LogInformation(", StringComparison.Ordinal);
            var logEnd = source.IndexOf("catch (Exception)", logStart, StringComparison.Ordinal);
            var logBlock = source[logStart..logEnd];

            Assert.Contains("HMACSHA256.HashData", source, StringComparison.Ordinal);
            Assert.Contains("DigestAttribution(actor.ClientName, \"client\"", source, StringComparison.Ordinal);
            Assert.Contains("DigestAttribution(actor.DeviceId, \"device\"", source, StringComparison.Ordinal);
            Assert.DoesNotContain("actor.ClientName", logBlock, StringComparison.Ordinal);
            Assert.DoesNotContain("actor.DeviceId", logBlock, StringComparison.Ordinal);
            Assert.DoesNotContain("Exception", logBlock, StringComparison.Ordinal);
        }

        [Fact]
        public void TheOneShotClosesBeforePublicationAndNeverRetries()
        {
            var source = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile("PlatformAuditStore.cs")));
            var completionStart = source.IndexOf("public bool Complete(PlatformAuditResultCode resultCode)", StringComparison.Ordinal);
            Assert.True(completionStart >= 0);
            var completionEnd = source.IndexOf("public void Dispose()", completionStart, StringComparison.Ordinal);
            Assert.True(completionEnd > completionStart);
            var completion = source[completionStart..completionEnd];

            Assert.True(
                completion.IndexOf("Interlocked.CompareExchange", StringComparison.Ordinal)
                    < completion.IndexOf("_owner.TryComplete", StringComparison.Ordinal));
            Assert.Single(Regex.Matches(completion, @"_owner\.TryComplete\s*\(").Cast<Match>());
            Assert.DoesNotContain("catch", completion, StringComparison.Ordinal);
            Assert.DoesNotContain("while", completion, StringComparison.Ordinal);
        }

        [Fact]
        public void CompletionEvidenceCannotBeConstructedOutsideTheStore()
        {
            var store = typeof(PlatformAuditStore);
            var attempt = store.GetNestedType("AuditAttempt", BindingFlags.NonPublic);
            var prefix = store.GetNestedType("AuditPrefix", BindingFlags.NonPublic);

            Assert.NotNull(attempt);
            Assert.NotNull(prefix);
            Assert.True(attempt!.IsNestedPrivate);
            Assert.True(prefix!.IsNestedPrivate);
            Assert.Empty(attempt.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
            Assert.Empty(prefix.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
            Assert.Equal(typeof(IPlatformAuditAttempt), store.GetMethod("Begin", BindingFlags.NonPublic | BindingFlags.Instance)!.ReturnType);
            Assert.Equal(typeof(IPlatformAuditAttempt), store.GetMethod("BeginUnresolved", BindingFlags.NonPublic | BindingFlags.Instance)!.ReturnType);

            var nonPrivateCompletionPaths = store
                .GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                .Where(method => !method.IsPrivate)
                .Concat(typeof(IPlatformAuditAttempt).GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)
                    .Where(method => !method.IsPrivate));

            Assert.DoesNotContain(
                nonPrivateCompletionPaths.SelectMany(method => method.GetParameters()),
                parameter => parameter.ParameterType == typeof(string));
        }

        private static string SourceFile(string name, [CallerFilePath] string sourceFile = "") =>
            Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy",
                "Platform",
                name));

        private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
            Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy"));

        private static bool ContainsAuditStorageType(Type type)
        {
            if (type == typeof(PlatformAuditStore)
                || type == typeof(PlatformAuditRecord)
                || type == typeof(PlatformAuditHealthSnapshot))
            {
                return true;
            }

            if (type.HasElementType && type.GetElementType() is Type elementType)
            {
                return ContainsAuditStorageType(elementType);
            }

            return type.IsGenericType && type.GetGenericArguments().Any(ContainsAuditStorageType);
        }
    }
}
