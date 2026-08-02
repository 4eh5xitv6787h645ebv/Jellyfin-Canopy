using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformConcurrencyGuardTests
    {
        private static readonly Regex HandRolledValidator = new(
            @"[\""']ETag[\""']|\.\s*ETag\b|EntityTagHeaderValue",
            RegexOptions.CultureInvariant,
            TimeSpan.FromSeconds(1));

        [Fact]
        public void PlatformActionsDoNotHandRollValidators()
        {
            var violations = ControllerSources()
                .Where(source => HasHandRolledValidator(File.ReadAllText(source)))
                .Select(Path.GetFileName)
                .OrderBy(name => name, StringComparer.Ordinal)
                .ToList();

            Assert.Empty(violations);
        }

        [Theory]
        [InlineData("Response.Headers[\"ETag\"] = value;")]
        [InlineData("Response.Headers.Append(\"ETag\", value);")]
        [InlineData("Response.Headers.TryAdd(\"ETag\", value);")]
        [InlineData("Response.GetTypedHeaders().ETag = value;")]
        [InlineData("var tag = new EntityTagHeaderValue(value);")]
        public void GuardRejectsPlantedHandRolledValidators(string planted)
        {
            Assert.True(HasHandRolledValidator(planted));
        }

        private static bool HasHandRolledValidator(string source) => HandRolledValidator.IsMatch(source);

        private static IEnumerable<string> ControllerSources([CallerFilePath] string sourceFile = "")
        {
            var platformDirectory = Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..", "Jellyfin.Plugin.JellyfinCanopy", "Platform"));
            return Directory.EnumerateFiles(platformDirectory, "*Controller.cs", SearchOption.TopDirectoryOnly);
        }
    }
}
