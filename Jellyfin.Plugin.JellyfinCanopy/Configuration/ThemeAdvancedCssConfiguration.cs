using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Separately persisted, local-only advanced CSS declarations. This state is
    /// deliberately absent from shareable Theme Studio profile documents.
    /// </summary>
    public sealed class UserThemeCssConfiguration : IRevisionedUserConfiguration
    {
        public long Revision { get; set; }

        public int SchemaVersion { get; set; } = ThemeAdvancedCssPolicy.CurrentSchemaVersion;

        public bool Enabled { get; set; }

        public List<ThemeCssSnippet> Snippets { get; set; } = new List<ThemeCssSnippet>();

        [System.Text.Json.Serialization.JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    public sealed class ThemeCssSnippet
    {
        public string Id { get; set; } = string.Empty;

        public string Name { get; set; } = string.Empty;

        public string Target { get; set; } = "root";

        public bool Enabled { get; set; } = true;

        public string Declarations { get; set; } = string.Empty;

        [System.Text.Json.Serialization.JsonExtensionData]
        public Dictionary<string, JsonElement> ExtensionData { get; set; }
            = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    }

    /// <summary>
    /// Fail-closed grammar for the advanced path. Users may provide declaration
    /// lists only; Canopy owns every selector and scopes it to supported modern
    /// content routes. URL-bearing and executable CSS constructs are rejected.
    /// </summary>
    internal static class ThemeAdvancedCssPolicy
    {
        public const int CurrentSchemaVersion = 1;
        public const int MaximumPersistedBytes = 64 * 1024;
        public const int MaximumSnippets = 16;
        public const int MaximumSnippetNameRunes = 80;
        public const int MaximumDeclarationBytes = 4096;
        public const int MaximumDeclarationsPerSnippet = 64;

        private static readonly HashSet<string> Targets = new(StringComparer.Ordinal)
        {
            "root", "shell", "cards", "details", "dialogs", "player"
        };

        private static readonly Regex IdentifierPattern = new(
            "^[a-z][a-z0-9-]{0,63}$",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly Regex PropertyPattern = new(
            "^(?:--[a-z][a-z0-9-]{0,95}|-?[a-z][a-z0-9-]{0,63})$",
            RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static readonly string[] ForbiddenFragments =
        {
            "@", "{", "}", "<", ">", "\\", "/*", "*/", "url(", "image(",
            "image-set(", "paint(", "expression(", "javascript:", "vbscript:",
            "data:", "blob:", "file:", "http:", "https:", "//", "behavior:",
            "-moz-binding", "src:"
        };

        public static bool Validate(UserThemeCssConfiguration? document)
        {
            if (document == null
                || document.Revision < 0
                || document.SchemaVersion != CurrentSchemaVersion
                || document.Snippets == null
                || document.Snippets.Count > MaximumSnippets
                || document.ExtensionData == null
                || document.ExtensionData.Count != 0)
            {
                return false;
            }

            var ids = new HashSet<string>(StringComparer.Ordinal);
            return document.Snippets.All(snippet => ValidateSnippet(snippet) && ids.Add(snippet.Id));
        }

        public static bool ValidateDeclarations(string? declarations)
        {
            if (declarations == null
                || Encoding.UTF8.GetByteCount(declarations) > MaximumDeclarationBytes
                || declarations.Any(character => (char.IsControl(character)
                    && character is not '\r' and not '\n' and not '\t')))
            {
                return false;
            }

            var lowered = declarations.ToLowerInvariant();
            if (ForbiddenFragments.Any(lowered.Contains))
            {
                return false;
            }

            var count = 0;
            foreach (var rawDeclaration in declarations.Split(';'))
            {
                var declaration = rawDeclaration.Trim();
                if (declaration.Length == 0)
                {
                    continue;
                }

                count++;
                if (count > MaximumDeclarationsPerSnippet)
                {
                    return false;
                }

                var separator = declaration.IndexOf(':');
                if (separator <= 0 || separator == declaration.Length - 1)
                {
                    return false;
                }

                var property = declaration.Substring(0, separator).Trim().ToLowerInvariant();
                var value = declaration.Substring(separator + 1).Trim();
                if (!PropertyPattern.IsMatch(property)
                    || value.Length == 0
                    || string.Equals(property, "content", StringComparison.Ordinal)
                    || string.Equals(property, "-moz-binding", StringComparison.Ordinal)
                    || string.Equals(property, "behavior", StringComparison.Ordinal)
                    || string.Equals(property, "src", StringComparison.Ordinal))
                {
                    return false;
                }
            }

            return count > 0;
        }

        private static bool ValidateSnippet(ThemeCssSnippet? snippet)
            => snippet != null
                && snippet.ExtensionData != null
                && snippet.ExtensionData.Count == 0
                && IdentifierPattern.IsMatch(snippet.Id ?? string.Empty)
                && IsDisplayName(snippet.Name)
                && Targets.Contains(snippet.Target ?? string.Empty)
                && ValidateDeclarations(snippet.Declarations);

        private static bool IsDisplayName(string? value)
            => value != null
                && value.Length > 0
                && string.Equals(value, value.Trim(), StringComparison.Ordinal)
                && value.EnumerateRunes().Count() <= MaximumSnippetNameRunes
                && !value.Any(character => char.IsControl(character));
    }
}
