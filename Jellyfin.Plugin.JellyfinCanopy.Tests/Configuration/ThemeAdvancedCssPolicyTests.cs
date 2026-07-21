using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration;

public sealed class ThemeAdvancedCssPolicyTests
{
    [Fact]
    public void TypedDeclarationDocument_AcceptsLocalBoundedValues()
    {
        var document = ValidDocument();

        var validation = PersistedPayloadPolicy.Validate(document);

        Assert.True(validation.IsValid);
        Assert.True(ThemeAdvancedCssPolicy.ValidateDeclarations(
            "--jc-theme-custom-accent:#8f76ff; border-radius:12px; opacity:.9;"));
    }

    [Theory]
    [InlineData("background:url(https://example.invalid/a.png);")]
    [InlineData("@import 'theme.css';")]
    [InlineData("content:'<script>alert(1)</script>';")]
    [InlineData("background-image:image(data:image/png;base64,abc);")]
    [InlineData("behavior:expression(alert(1));")]
    [InlineData("src:local(font);")]
    [InlineData("color:red}body{display:none;")]
    public void DeclarationGrammar_RejectsRemoteExecutableAndSelectorConstructs(string declarations)
    {
        var document = ValidDocument();
        document.Snippets[0].Declarations = declarations;

        Assert.False(ThemeAdvancedCssPolicy.ValidateDeclarations(declarations));
        Assert.Equal(PersistedPayloadStatus.Invalid, PersistedPayloadPolicy.Validate(document).Status);
    }

    [Fact]
    public void Document_RejectsUnknownDuplicateAndOverLimitState()
    {
        var unknown = ValidDocument();
        using var value = JsonDocument.Parse("true");
        unknown.ExtensionData["Future"] = value.RootElement.Clone();
        AssertInvalid(unknown);

        var duplicate = ValidDocument();
        duplicate.Snippets.Add(new ThemeCssSnippet
        {
            Id = duplicate.Snippets[0].Id,
            Name = "Duplicate",
            Target = "cards",
            Declarations = "opacity:.8;"
        });
        AssertInvalid(duplicate);

        var tooMany = ValidDocument();
        tooMany.Snippets = Enumerable.Range(0, ThemeAdvancedCssPolicy.MaximumSnippets + 1)
            .Select(index => new ThemeCssSnippet
            {
                Id = $"snippet-{index}",
                Name = $"Snippet {index}",
                Target = "root",
                Declarations = "opacity:.8;"
            }).ToList();
        AssertInvalid(tooMany);

        var longName = ValidDocument();
        longName.Snippets[0].Name = new string('x', ThemeAdvancedCssPolicy.MaximumSnippetNameRunes + 1);
        AssertInvalid(longName);

        var longDeclarations = ValidDocument();
        longDeclarations.Snippets[0].Declarations = "--custom:" + new string(
            'x', ThemeAdvancedCssPolicy.MaximumDeclarationBytes);
        AssertInvalid(longDeclarations);
    }

    [Fact]
    public void Document_AllowsEveryOwnedTargetAndRejectsArbitrarySelectors()
    {
        foreach (var target in new[] { "root", "shell", "cards", "details", "dialogs", "player" })
        {
            var document = ValidDocument();
            document.Snippets[0].Target = target;
            Assert.True(PersistedPayloadPolicy.Validate(document).IsValid, target);
        }

        var unsupported = ValidDocument();
        unsupported.Snippets[0].Target = "login form, body";
        AssertInvalid(unsupported);
    }

    private static UserThemeCssConfiguration ValidDocument()
        => new()
        {
            Enabled = true,
            Snippets = new List<ThemeCssSnippet>
            {
                new()
                {
                    Id = "local-accent",
                    Name = "Local accent",
                    Target = "root",
                    Enabled = true,
                    Declarations = "--jc-theme-custom-accent:#8f76ff;"
                }
            }
        };

    private static void AssertInvalid(UserThemeCssConfiguration document)
        => Assert.Equal(PersistedPayloadStatus.Invalid, PersistedPayloadPolicy.Validate(document).Status);
}
