using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Guards the resolve-to-prepare handle owner against authority drift.</summary>
    public sealed class PlatformPrepareHandleArchitectureTests
    {
        [Fact]
        public void OwnerIsHttpLoggingCapabilityAndRouteFree()
        {
            var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile()));
            foreach (var forbidden in new[]
            {
                "Microsoft.AspNetCore",
                "HttpContext",
                "Controller",
                "Route(",
                "HttpGet",
                "HttpPost",
                "ILogger",
                "PlatformActionCapabilityService",
                "IServiceProvider",
                "IServiceCollection",
            })
            {
                Assert.DoesNotContain(forbidden, code, StringComparison.Ordinal);
            }
        }

        [Fact]
        public void OwnerHasOneParameterlessPublicConstructorAndNoHandleReadSurface()
        {
            var constructors = typeof(PlatformPrepareHandleOwner)
                .GetConstructors(BindingFlags.Instance | BindingFlags.Public);
            Assert.Single(constructors);
            Assert.Empty(constructors[0].GetParameters());
            Assert.DoesNotContain(
                typeof(PlatformPrepareHandleOwner).GetProperties(BindingFlags.Instance | BindingFlags.Public),
                property => property.PropertyType == typeof(string)
                    || property.PropertyType == typeof(byte[]));
            Assert.DoesNotContain(
                typeof(PlatformPrepareHandleOwner).GetMethods(BindingFlags.Instance | BindingFlags.Public),
                method => method.Name is "IssueOrReuse" or "Resolve");
        }

        [Fact]
        public void BoundsAndSingletonLifetimeAreExact()
        {
            Assert.Equal(1024, PlatformPrepareHandleOwner.MaximumEntries);
            Assert.Equal(24, PlatformPrepareHandleOwner.MaximumEntriesPerActor);
            Assert.Equal(32, PlatformPrepareHandleOwner.HandleEntropyBytes);
            Assert.Equal(43, PlatformPrepareHandleOwner.MaximumHandleCharacters);
            Assert.Equal(TimeSpan.FromMinutes(5), PlatformPrepareHandleOwner.HandleTimeToLive);
            Assert.Equal(4096, PlatformPrepareSnapshot.MaximumPrivateStateBytes);

            var registrations = PlatformHostSeamTests.CodeOnly(File.ReadAllText(RegistrationFile()));
            const string singleton = "serviceCollection.AddSingleton<PlatformPrepareHandleOwner>();";
            Assert.Equal(1, Count(registrations, singleton));
            Assert.DoesNotContain("AddTransient<PlatformPrepareHandleOwner>", registrations, StringComparison.Ordinal);
            Assert.DoesNotContain("AddScoped<PlatformPrepareHandleOwner>", registrations, StringComparison.Ordinal);
        }

        [Fact]
        public void SnapshotAndOutcomesDoNotRenderPrivateStateOrOpaqueHandles()
        {
            foreach (var type in new[]
            {
                typeof(PlatformPrepareSnapshot),
                typeof(PlatformPrepareHandleIssue),
                typeof(PlatformPrepareClientContext),
            })
            {
                Assert.DoesNotContain(
                    type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly),
                    method => method.Name == nameof(ToString));
            }
        }

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

        private static string SourceFile([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy",
                "Platform",
                "PlatformPrepareHandleOwner.cs"));

        private static string RegistrationFile([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy",
                "PluginServiceRegistrator.cs"));
    }
}
