using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Guards the action-capability authority against route and secret-surface drift.</summary>
    public class PlatformActionCapabilityArchitectureTests
    {
        [Fact]
        public void ServiceIsHttpFreeAndHasNoLoggingOrCallerRegistrationSurface()
        {
            var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourceFile("PlatformActionCapabilityService.cs")));
            foreach (var forbidden in new[]
            {
                "Microsoft.AspNetCore",
                "HttpContext",
                "Controller",
                "Route(",
                "HttpGet",
                "HttpPost",
                "ILogger",
                "IServiceCollection",
                "IServiceProvider",
                "Register",
                "Manifest",
            })
            {
                Assert.DoesNotContain(forbidden, code, StringComparison.Ordinal);
            }
        }

        [Fact]
        public void OnlyTheParameterlessConstructorIsPublicAndNoKeyMaterialIsExposed()
        {
            var publicConstructors = typeof(PlatformActionCapabilityService)
                .GetConstructors(BindingFlags.Instance | BindingFlags.Public);
            Assert.Single(publicConstructors);
            Assert.Empty(publicConstructors[0].GetParameters());

            Assert.DoesNotContain(
                typeof(PlatformActionCapabilityService).GetProperties(BindingFlags.Instance | BindingFlags.Public),
                property => property.PropertyType == typeof(byte[]) || property.PropertyType == typeof(string));
            Assert.DoesNotContain(
                typeof(PlatformActionCapabilityService).GetFields(BindingFlags.Instance | BindingFlags.Public),
                field => field.FieldType == typeof(byte[]) || field.FieldType == typeof(string));
        }

        [Fact]
        public void CapabilityLifecycleIsExplicitlyInspectValidateThenConsume()
        {
            var methods = typeof(PlatformActionCapabilityService)
                .GetMethods(BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)
                .Where(method => !method.IsSpecialName)
                .Select(method => method.Name)
                .Where(name => name is "Mint" or "Inspect" or "IsInspectionFor" or "ValidateCurrent" or "Consume" or "InvalidateOutstandingCapabilities")
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(
                new[] { "Consume", "Inspect", "InvalidateOutstandingCapabilities", "IsInspectionFor", "Mint", "ValidateCurrent" },
                methods);
            Assert.DoesNotContain(
                typeof(PlatformActionCapabilityService).GetMethods(BindingFlags.Instance | BindingFlags.Public),
                method => method.Name.Contains("Invoke", StringComparison.Ordinal)
                    || method.Name.Contains("Execute", StringComparison.Ordinal));
        }

        [Fact]
        public void CryptographicAndLedgerBoundsAreExact()
        {
            Assert.Equal(32, PlatformActionCapabilityService.AuthorityKeyBytes);
            Assert.Equal(32, PlatformActionCapabilityService.AuthenticationTagBytes);
            Assert.Equal(32, PlatformActionCapabilityService.NonceBytes);
            Assert.Equal(32, PlatformActionCapabilityService.InputDigestBytes);
            Assert.Equal(1024, PlatformActionCapabilityService.MaximumLedgerEntries);
            Assert.Equal(TimeSpan.FromSeconds(60), PlatformActionCapabilityService.CapabilityTimeToLive);
            Assert.InRange(PlatformActionCapabilityService.MaximumTokenCharacters, 512, 1024);
        }

        [Fact]
        public void PluginRegistersExactlyOneSingletonAuthority()
        {
            var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(ProductionFile("PluginServiceRegistrator.cs")));
            const string registration = "serviceCollection.AddSingleton<PlatformActionCapabilityService>();";

            Assert.Equal(1, Count(code, registration));
            Assert.DoesNotContain("AddTransient<PlatformActionCapabilityService>", code, StringComparison.Ordinal);
            Assert.DoesNotContain("AddScoped<PlatformActionCapabilityService>", code, StringComparison.Ordinal);
        }

        [Fact]
        public void OutcomeObjectsCannotLeakCapabilitiesThroughToStringOverrides()
        {
            foreach (var type in new[]
            {
                typeof(PlatformCapabilityMintOutcome),
                typeof(PlatformCapabilityInspection),
                typeof(PlatformActionCapabilityService.PlatformCapabilityValidation),
            })
            {
                Assert.DoesNotContain(
                    type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.DeclaredOnly),
                    method => method.Name == nameof(ToString));
            }
        }

        [Fact]
        public void SuccessfulValidationEvidenceRequiresAnUnexposedServiceOwnedSeal()
        {
            var evidenceType = typeof(PlatformActionCapabilityService.PlatformCapabilityValidation);
            var serviceSeal = typeof(PlatformActionCapabilityService).GetField(
                "_validationSeal",
                BindingFlags.Instance | BindingFlags.NonPublic);
            var evidenceSeal = evidenceType.GetField("_seal", BindingFlags.Instance | BindingFlags.NonPublic);

            Assert.Equal(typeof(PlatformActionCapabilityService), evidenceType.DeclaringType);
            Assert.NotNull(serviceSeal);
            Assert.True(serviceSeal!.IsPrivate);
            Assert.True(serviceSeal.IsInitOnly);
            Assert.Equal(typeof(object), serviceSeal.FieldType);
            Assert.NotNull(evidenceSeal);
            Assert.True(evidenceSeal!.IsPrivate);
            Assert.True(evidenceSeal.IsInitOnly);
            Assert.Equal(typeof(object), evidenceSeal.FieldType);
            Assert.DoesNotContain(
                evidenceType.GetProperties(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic),
                property => property.PropertyType == typeof(object));
            Assert.Equal(PlatformCapabilityValidationKind.InvalidCapability, default);
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

        private static string SourceFile(string name) =>
            Directory.EnumerateFiles(PlatformRoot(), "*.cs", SearchOption.TopDirectoryOnly)
                .Single(file => Path.GetFileName(file) == name);

        private static string ProductionFile(string name) =>
            Directory.EnumerateFiles(ProductionRoot(), "*.cs", SearchOption.AllDirectories)
                .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                    && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
                .Single(file => Path.GetFileName(file) == name);

        private static string PlatformRoot([CallerFilePath] string sourceFile = "") =>
            Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy",
                "Platform"));

        private static string ProductionRoot([CallerFilePath] string sourceFile = "") =>
            Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy"));
    }
}
