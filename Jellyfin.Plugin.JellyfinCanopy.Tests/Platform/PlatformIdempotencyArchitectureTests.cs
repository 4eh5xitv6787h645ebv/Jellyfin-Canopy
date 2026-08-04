using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>Prevents the bounded store from being replaced by an unbounded cache owner.</summary>
    public class PlatformIdempotencyArchitectureTests
    {
        private static readonly Regex StateOwner = new(
            @"^\s*(?:private|internal|public|protected)\s+(?:static\s+)?(?:readonly\s+)?"
            + @"(?:ReadOnlyDictionary|Dictionary|ConcurrentDictionary|IMemoryCache|MemoryCache|BoundedTtlCache)"
            + @"(?:<[^;\r\n]+>)?\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*(?:=|;)",
            RegexOptions.Compiled | RegexOptions.CultureInvariant | RegexOptions.Multiline);

        private static readonly Dictionary<string, string> AllowedStateOwners = new(StringComparer.Ordinal)
        {
            ["PlatformActionCapabilityService.cs:_ledger"] = "The sole reviewed bounded short-lived capability nonce owner.",
            ["PlatformActionAdmissionLimiter.cs:_gates"] = "The reviewed fixed-cap actor/operation admission owner.",
            ["PlatformErrorCode.cs:Definitions"] = "Immutable error-code definition table, not request state.",
            ["PlatformIdempotencyStore.cs:_entries"] = "The sole reviewed bounded idempotency state owner.",
            ["PlatformPrepareHandleOwner.cs:_byActor"] = "The reviewed 24-per-actor prepare-handle eviction index.",
            ["PlatformPrepareHandleOwner.cs:_byHandle"] = "The reviewed fixed-cap opaque prepare-handle owner.",
            ["PlatformPrepareHandleOwner.cs:_bySemantic"] = "The reviewed stable semantic prepare-handle reuse index.",
            ["PlatformPreparedActionContextOwner.cs:_entries"] = "The reviewed fixed-cap prepared action context owner.",
            ["PlatformProviderRegistry.cs:_activeProviderInvocations"] = "The reviewed registry-owned zero-queue per-provider bulkhead index.",
        };

        [Fact]
        public void IdempotencyStateHasOneSpecializedBoundedOwner()
        {
            var owners = Directory.EnumerateFiles(PlatformSourceDirectory(), "*.cs", SearchOption.AllDirectories)
                .SelectMany(file => FindStateOwners(Path.GetFileName(file), File.ReadAllText(file)))
                .OrderBy(owner => owner, StringComparer.Ordinal)
                .ToArray();

            Assert.Equal(AllowedStateOwners.Keys.OrderBy(owner => owner, StringComparer.Ordinal), owners);
            var source = File.ReadAllText(SourcePath("PlatformIdempotencyStore.cs"));
            var code = PlatformHostSeamTests.CodeOnly(source);
            Assert.Contains("MaximumEntries", code, StringComparison.Ordinal);
            Assert.Contains("MaximumStoredResultBytes", code, StringComparison.Ordinal);
            Assert.Contains("MaximumResultBytes", code, StringComparison.Ordinal);

            var capabilityCode = PlatformHostSeamTests.CodeOnly(
                File.ReadAllText(SourcePath("PlatformActionCapabilityService.cs")));
            Assert.Contains("MaximumLedgerEntries", capabilityCode, StringComparison.Ordinal);
            Assert.Contains("CapabilityTimeToLive", capabilityCode, StringComparison.Ordinal);
            Assert.Contains("RemoveExpiredEntries", capabilityCode, StringComparison.Ordinal);
        }

        [Fact]
        public void TheGuardWouldRejectUnboundedCacheWrites()
        {
            const string planted = "private static readonly Dictionary<string, object> IdempotencyCache = new();";
            Assert.Equal(
                new[] { "RoguePlatformController.cs:IdempotencyCache" },
                FindStateOwners("RoguePlatformController.cs", planted));
            Assert.False(AllowedStateOwners.ContainsKey("RoguePlatformController.cs:IdempotencyCache"));
        }

        [Fact]
        public void FollowerRegistrationIsBoundedAndTheGuardRejectsAnUnboundedWaitPath()
        {
            var source = File.ReadAllText(SourcePath("PlatformIdempotencyStore.cs"));
            const string planted = "return await entry.Completion.Task.WaitAsync(requestCancellationToken);";

            Assert.False(HasUnboundedFollowerRegistration(source));
            Assert.True(HasUnboundedFollowerRegistration(planted));
        }

        [Fact]
        public void SemanticResultsExposeNoMvcOrRequestCorrelationState()
        {
            var properties = typeof(Jellyfin.Plugin.JellyfinCanopy.Platform.PlatformIdempotencyResult)
                .GetProperties()
                .Select(property => property.Name)
                .ToArray();

            Assert.DoesNotContain("CorrelationId", properties);
            Assert.DoesNotContain(properties, name => name.Contains("ActionResult", StringComparison.Ordinal));
        }

        [Fact]
        public void SemanticSizingUsesTheBoundedWriterRatherThanAllocatingTheWholePayload()
        {
            var code = PlatformHostSeamTests.CodeOnly(File.ReadAllText(SourcePath("PlatformIdempotency.cs")));

            Assert.Contains("IBufferWriter<byte>", code, StringComparison.Ordinal);
            Assert.DoesNotContain("SerializeToUtf8Bytes", code, StringComparison.Ordinal);
        }

        private static string SourcePath(string name, [CallerFilePath] string sourceFile = "") =>
            Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!,
                "..",
                "..",
                "Jellyfin.Plugin.JellyfinCanopy",
                "Platform",
                name));

        internal static string[] FindStateOwners(string fileName, string source)
        {
            var code = PlatformHostSeamTests.CodeOnly(source);
            return StateOwner.Matches(code)
                .Select(match => $"{fileName}:{match.Groups["name"].Value}")
                .ToArray();
        }

        internal static bool HasUnboundedFollowerRegistration(string source)
        {
            var code = PlatformHostSeamTests.CodeOnly(source);
            return code.Contains(".WaitAsync(", StringComparison.Ordinal)
                && (!code.Contains("MaximumFollowersPerEntry", StringComparison.Ordinal)
                    || !code.Contains("MaximumFollowers", StringComparison.Ordinal)
                    || !code.Contains("_followerCount", StringComparison.Ordinal)
                    || !code.Contains("finally", StringComparison.Ordinal));
        }

        private static string PlatformSourceDirectory() => Path.GetDirectoryName(SourcePath("placeholder.cs"))!;
    }
}
