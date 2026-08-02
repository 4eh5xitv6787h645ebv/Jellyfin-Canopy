using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.AspNetCore.Http;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Guards the fixed action coordinator against dispatch and authority drift.</summary>
    public class PlatformActionInvocationArchitectureTests
    {
        [Fact]
        public void DispatcherHasExactlyThreeNamedPortsAndNoExtensibleRegistry()
        {
            var dispatcher = typeof(PlatformFirstPartyActionDispatcher);
            var fields = dispatcher.GetFields(BindingFlags.Instance | BindingFlags.NonPublic);

            Assert.Equal(
                new[]
                {
                    typeof(IHiddenContentPlatformActionPort),
                    typeof(ISeerrPlatformActionPort),
                    typeof(ISpoilerGuardPlatformActionPort),
                },
                fields.Select(field => field.FieldType).OrderBy(type => type.Name, StringComparer.Ordinal));
            Assert.DoesNotContain(fields, field => IsRegistry(field.FieldType));

            var source = Code("PlatformFirstPartyActionDispatcher.cs");
            foreach (var forbidden in new[]
            {
                "IServiceProvider",
                "System.Reflection",
                "Dictionary<",
                "ConcurrentDictionary<",
                "IEnumerable<",
                "Func<",
                "Register",
            })
            {
                Assert.DoesNotContain(forbidden, source, StringComparison.Ordinal);
            }
        }

        [Fact]
        public void OwnersReceiveOnlySafeProjectionsAndValidatedInputs()
        {
            foreach (var port in new[]
            {
                typeof(IHiddenContentPlatformActionPort),
                typeof(ISeerrPlatformActionPort),
                typeof(ISpoilerGuardPlatformActionPort),
            })
            {
                var invoke = Assert.Single(port.GetMethods(), method => method.Name == "InvokeAsync");
                var parameters = invoke.GetParameters().Select(parameter => parameter.ParameterType).ToArray();
                Assert.Equal(typeof(PlatformActor), parameters[0]);
                Assert.Equal(typeof(HostAccessibleItem), parameters[1]);
                Assert.Equal(typeof(IPlatformValidatedActionInput), parameters[2]);
                Assert.DoesNotContain(parameters, type => type == typeof(HttpContext)
                    || type == typeof(PlatformPreparedActionContext)
                    || type == typeof(PlatformActionInvokeRequest)
                    || type == typeof(string)
                    || type == typeof(byte[]));
            }
        }

        [Fact]
        public void CoordinatorPinsInspectReauthorizeIdempotencyConsumeOwnerOrder()
        {
            var source = Code("PlatformActionInvocationCoordinator.cs");
            var inspect = source.IndexOf("_capabilities.Inspect(", StringComparison.Ordinal);
            var initialAuthority = source.IndexOf("ResolveCurrent(", inspect, StringComparison.Ordinal);
            var idempotency = source.IndexOf("_idempotency.ExecuteCoordinatedAsync(", initialAuthority, StringComparison.Ordinal);
            var queuedAuthority = source.IndexOf("ResolveCurrent(", idempotency, StringComparison.Ordinal);
            var consume = source.IndexOf("_capabilities.Consume(", queuedAuthority, StringComparison.Ordinal);
            var owner = source.IndexOf("_dispatcher.InvokeAsync(", consume, StringComparison.Ordinal);

            Assert.True(inspect >= 0);
            Assert.True(inspect < initialAuthority);
            Assert.True(initialAuthority < idempotency);
            Assert.True(idempotency < queuedAuthority);
            Assert.True(queuedAuthority < consume);
            Assert.True(consume < owner);
            Assert.True(
                source.IndexOf("execution.MarkSideEffectStarted();", queuedAuthority, StringComparison.Ordinal)
                    < consume);
        }

        [Fact]
        public void PreparedAndAdmissionOwnersHaveExactBoundsAndSingletonLifetimes()
        {
            Assert.Equal(1024, PlatformPreparedActionContextOwner.MaximumEntries);
            Assert.Equal(4096, PlatformPreparedActionContextOwner.MaximumPrivateStateBytes);
            Assert.Equal(1024, PlatformActionAdmissionLimiter.MaximumKeys);
            Assert.Equal(8, PlatformActionAdmissionLimiter.MaximumWaitersPerKey);
            Assert.Equal(1024, PlatformActionAdmissionLimiter.MaximumWaiters);

            var registrations = ProductionCode("PluginServiceRegistrator.cs");
            Assert.Equal(1, Count(registrations, "AddSingleton<PlatformPreparedActionContextOwner>();"));
            Assert.Equal(1, Count(registrations, "AddSingleton<PlatformActionAdmissionLimiter>();"));
            Assert.DoesNotContain("AddTransient<PlatformPreparedActionContextOwner>", registrations, StringComparison.Ordinal);
            Assert.DoesNotContain("AddScoped<PlatformActionAdmissionLimiter>", registrations, StringComparison.Ordinal);
        }

        [Fact]
        public void CoordinatorAndPreparedOwnerStayHttpFree()
        {
            foreach (var source in new[]
            {
                Code("PlatformActionInvocationCoordinator.cs"),
                Code("PlatformPreparedActionContextOwner.cs"),
                Code("PlatformFirstPartyActionDispatcher.cs"),
            })
            {
                Assert.DoesNotContain("Microsoft.AspNetCore", source, StringComparison.Ordinal);
                Assert.DoesNotContain("HttpContext", source, StringComparison.Ordinal);
                Assert.DoesNotContain("ClaimsPrincipal", source, StringComparison.Ordinal);
                Assert.DoesNotContain("MediaBrowser.", source, StringComparison.Ordinal);
            }
        }

        private static bool IsRegistry(Type type)
            => type.IsArray
                || (type.IsGenericType && new[]
                {
                    typeof(IEnumerable<>),
                    typeof(IReadOnlyCollection<>),
                    typeof(IReadOnlyDictionary<,>),
                    typeof(Dictionary<,>),
                }.Contains(type.GetGenericTypeDefinition()));

        private static int Count(string source, string value)
        {
            var count = 0;
            var offset = 0;
            while ((offset = source.IndexOf(value, offset, StringComparison.Ordinal)) >= 0)
            {
                count++;
                offset += value.Length;
            }

            return count;
        }

        private static string Code(string name)
            => PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile(name)));

        private static string ProductionCode(string name)
            => PlatformHostSeamTests.CodeOnly(File.ReadAllText(ProductionFile(name)));

        private static string SourceFile(string name, [CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy",
                "Platform",
                name));

        private static string ProductionFile(string name, [CallerFilePath] string sourceFile = "")
            => Directory.EnumerateFiles(
                    Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy")),
                    name,
                    SearchOption.AllDirectories)
                .Single(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal));
    }
}
