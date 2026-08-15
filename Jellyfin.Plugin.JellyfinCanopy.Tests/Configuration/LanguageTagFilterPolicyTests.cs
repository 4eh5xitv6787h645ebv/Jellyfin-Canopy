using System.Collections.Generic;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class LanguageTagFilterPolicyTests
{
    [Fact]
    public void MissingPolicy_PreservesInheritance()
    {
        Assert.True(LanguageTagFilterPolicyV1.TryNormalize(null, out var normalized));
        Assert.Null(normalized);
    }

    [Fact]
    public void ValidPolicy_IsCanonicalizedWithoutChangingOrderOrRegions()
    {
        var input = new LanguageTagFilterPolicy
        {
            Languages = new List<string> { "pt-br", "en-US", "pt-PT" },
            IncludeOriginal = true
        };
        Assert.True(LanguageTagFilterPolicyV1.TryNormalize(input, out var normalized));
        Assert.Equal(new[] { "pt-BR", "en-US", "pt-PT" }, normalized!.Languages);
        Assert.True(normalized.IncludeOriginal);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public void UnknownSchema_FailsClosed(int version)
    {
        Assert.False(LanguageTagFilterPolicyV1.TryNormalize(
            new LanguageTagFilterPolicy { SchemaVersion = version }, out var normalized));
        Assert.Null(normalized);
    }

    [Fact]
    public void DuplicateAndOversizedPoliciesFailClosed()
    {
        Assert.False(LanguageTagFilterPolicyV1.TryNormalize(new LanguageTagFilterPolicy
        {
            Languages = new List<string> { "en", "EN" }
        }, out _));
        var oversized = new LanguageTagFilterPolicy();
        for (var i = 0; i <= LanguageTagFilterPolicyV1.MaximumEntries; i++) oversized.Languages.Add($"x-{i}");
        Assert.False(LanguageTagFilterPolicyV1.TryNormalize(oversized, out _));
    }

    [Fact]
    public void AdministratorUpdateNormalizesAndRejectsInvalidPolicy()
    {
        var config = new PluginConfiguration
        {
            LanguageTagFilter = new LanguageTagFilterPolicy
            {
                Languages = new List<string> { "pt-br" }
            }
        };
        JellyfinCanopy.NormalizeLanguageTagFilterForUpdate(config);
        Assert.Equal("pt-BR", Assert.Single(config.LanguageTagFilter.Languages));

        config.LanguageTagFilter.SchemaVersion = 9;
        Assert.Throws<System.ArgumentException>(() => JellyfinCanopy.NormalizeLanguageTagFilterForUpdate(config));
    }
}
