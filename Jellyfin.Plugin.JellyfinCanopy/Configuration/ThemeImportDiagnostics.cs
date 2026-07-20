using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal sealed class ThemeImportDiagnostic
    {
        public ThemeImportDiagnostic(string code, string message)
        {
            Code = code;
            Message = message;
        }

        public string Code { get; }

        public string Message { get; }
    }

    /// <summary>
    /// Produces a small, non-reflective diagnostic list for untrusted profile
    /// documents. Messages never echo imported names, values, URLs, or secrets.
    /// </summary>
    internal static class ThemeImportDiagnostics
    {
        public const int MaximumDiagnostics = 8;
        private const int MaximumVisitedNodes = 10_000;
        private const int MaximumDepth = 16;

        private static readonly HashSet<string> CredentialPropertyNames = new(StringComparer.Ordinal)
        {
            "apikey", "accesskey", "accesstoken", "refreshtoken", "password",
            "secret", "credential", "credentials", "serverid", "serverurl", "userid"
        };

        public static IReadOnlyList<ThemeImportDiagnostic> Analyze(
            ThemeExportDocument? document,
            UserThemeConfiguration? candidate,
            PersistedPayloadValidation validation)
        {
            var diagnostics = new List<ThemeImportDiagnostic>(MaximumDiagnostics);
            void Add(string code, string message)
            {
                if (diagnostics.Count >= MaximumDiagnostics
                    || diagnostics.Any(item => string.Equals(item.Code, code, StringComparison.Ordinal)))
                {
                    return;
                }

                diagnostics.Add(new ThemeImportDiagnostic(code, message));
            }

            if (document == null)
            {
                Add("document_required", "A typed Theme Studio profile document is required.");
            }
            else
            {
                if (document.SchemaVersion < 0
                    || document.SchemaVersion > ThemeConfigurationPolicy.CurrentSchemaVersion)
                {
                    Add("unsupported_schema", "The theme uses an unsupported schema version.");
                }

                if (HasUnsupportedFields(document))
                {
                    Add("unsupported_field", "The theme contains fields outside the supported typed profile schema.");
                }

                try
                {
                    var root = JsonSerializer.SerializeToElement(document, PersistedJson.WriteOptions);
                    var nodes = 0;
                    Inspect(root, 0, ref nodes, Add);
                    if (nodes >= MaximumVisitedNodes)
                    {
                        Add("diagnostic_limit", "The theme is too complex to validate safely.");
                    }
                }
                catch (JsonException)
                {
                    Add("invalid_json_value", "The theme contains a value that cannot be validated safely.");
                }
            }

            if (validation.Status == PersistedPayloadStatus.TooLarge)
            {
                Add("payload_too_large", "The imported theme exceeds the supported size limit.");
            }
            else if (candidate == null || !validation.IsValid)
            {
                Add("invalid_document", "The imported theme does not satisfy the supported typed profile schema.");
            }

            return diagnostics;
        }

        private static void Inspect(
            JsonElement element,
            int depth,
            ref int nodes,
            Action<string, string> add)
        {
            if (depth > MaximumDepth || nodes++ >= MaximumVisitedNodes)
            {
                return;
            }

            if (element.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in element.EnumerateObject())
                {
                    var normalizedName = new string(property.Name
                        .Where(char.IsLetterOrDigit)
                        .Select(char.ToLowerInvariant)
                        .ToArray());
                    if (CredentialPropertyNames.Contains(normalizedName)
                        || normalizedName.Contains("credential", StringComparison.Ordinal)
                        || normalizedName.Contains("password", StringComparison.Ordinal)
                        || normalizedName.Contains("secret", StringComparison.Ordinal))
                    {
                        add("credential_field", "Credential, server identity, and private fields are not allowed in shared themes.");
                    }

                    Inspect(property.Value, depth + 1, ref nodes, add);
                    if (nodes >= MaximumVisitedNodes) return;
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in element.EnumerateArray())
                {
                    Inspect(item, depth + 1, ref nodes, add);
                    if (nodes >= MaximumVisitedNodes) return;
                }
            }
            else if (element.ValueKind == JsonValueKind.String)
            {
                var value = element.GetString() ?? string.Empty;
                var lowered = value.ToLowerInvariant();
                if (lowered.Contains("http://", StringComparison.Ordinal)
                    || lowered.Contains("https://", StringComparison.Ordinal)
                    || lowered.Contains("url(", StringComparison.Ordinal)
                    || lowered.Contains("@import", StringComparison.Ordinal))
                {
                    add("remote_url", "Remote URLs and imported resources are not allowed in shared themes.");
                }

                if (lowered.Contains("<script", StringComparison.Ordinal)
                    || lowered.Contains("<iframe", StringComparison.Ordinal)
                    || lowered.Contains("<html", StringComparison.Ordinal)
                    || lowered.Contains("<style", StringComparison.Ordinal)
                    || lowered.Contains("javascript:", StringComparison.Ordinal)
                    || lowered.Contains("onload=", StringComparison.Ordinal)
                    || lowered.Contains("onclick=", StringComparison.Ordinal))
                {
                    add("executable_markup", "Script, HTML, and executable markup are not allowed in shared themes.");
                }
            }
        }

        private static bool HasUnsupportedFields(ThemeExportDocument document)
            => HasValues(document.ExtensionData)
                || document.Profiles == null
                || document.Schedule == null
                || document.Profiles.Any(profile => profile == null
                    || HasValues(profile.ExtensionData)
                    || profile.Responsive == null
                    || HasValues(profile.Responsive.ExtensionData)
                    || (profile.Responsive.Phone != null && HasValues(profile.Responsive.Phone.ExtensionData))
                    || (profile.Responsive.Tablet != null && HasValues(profile.Responsive.Tablet.ExtensionData))
                    || (profile.Responsive.Desktop != null && HasValues(profile.Responsive.Desktop.ExtensionData))
                    || (profile.Responsive.Wide != null && HasValues(profile.Responsive.Wide.ExtensionData))
                    || (profile.Responsive.Tv != null && HasValues(profile.Responsive.Tv.ExtensionData))
                    || profile.Accessibility == null
                    || HasValues(profile.Accessibility.ExtensionData))
                || document.Schedule.Any(entry => entry == null || HasValues(entry.ExtensionData));

        private static bool HasValues(Dictionary<string, JsonElement>? values)
            => values == null || values.Count > 0;
    }
}
