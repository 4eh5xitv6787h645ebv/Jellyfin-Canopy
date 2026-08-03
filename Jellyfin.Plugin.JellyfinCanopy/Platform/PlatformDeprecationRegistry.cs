using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Routing;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>One versioned Platform operation's in-band deprecation schedule.</summary>
    internal sealed class PlatformDeprecationEntry
    {
        internal PlatformDeprecationEntry(
            string method,
            string path,
            DateTimeOffset deprecatedAtUtc,
            DateTimeOffset sunsetAtUtc,
            Version deprecatedInVersion,
            Version removalNotBeforeVersion)
        {
            Method = method;
            Path = path;
            DeprecatedAtUtc = deprecatedAtUtc;
            SunsetAtUtc = sunsetAtUtc;
            DeprecatedInVersion = deprecatedInVersion;
            RemovalNotBeforeVersion = removalNotBeforeVersion;
        }

        internal string Method { get; }

        internal string Path { get; }

        internal DateTimeOffset DeprecatedAtUtc { get; }

        internal DateTimeOffset SunsetAtUtc { get; }

        internal Version DeprecatedInVersion { get; }

        internal Version RemovalNotBeforeVersion { get; }

        /// <summary>RFC 9745 structured-field date.</summary>
        internal string DeprecationHeader => "@" + DeprecatedAtUtc.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture);

        /// <summary>RFC 8594 HTTP-date.</summary>
        internal string SunsetHeader => SunsetAtUtc.ToUniversalTime().ToString("R", CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// Immutable, bounded lookup over the machine-owned Platform deprecation registry.
    /// The shipped registry is parsed once; request handling performs no file I/O.
    /// </summary>
    internal sealed class PlatformDeprecationRegistry
    {
        internal const int SchemaVersion = 1;
        internal const int MaximumOperations = 64;
        internal const int MaximumRegistryBytes = 32 * 1024;
        internal const string ResourceName = "Jellyfin.Plugin.JellyfinCanopy.Platform.deprecations.json";

        private static readonly Regex CanopyVersion = new(
            "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
            RegexOptions.CultureInvariant);

        private static readonly JsonSerializerOptions RegistryJson = new()
        {
            PropertyNameCaseInsensitive = false,
            UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            MaxDepth = 8,
        };

        private readonly IReadOnlyDictionary<string, PlatformDeprecationEntry> _operations;
        private readonly IReadOnlyCollection<PlatformDeprecationEntry> _entries;

        private PlatformDeprecationRegistry(IReadOnlyDictionary<string, PlatformDeprecationEntry> operations)
        {
            _operations = operations;
            _entries = operations.Values.ToArray();
        }

        internal static PlatformDeprecationRegistry Shipped { get; } = LoadShipped();

        internal IReadOnlyCollection<PlatformDeprecationEntry> Operations => _entries;

        internal bool TryGet(string method, string path, out PlatformDeprecationEntry entry)
        {
            ArgumentNullException.ThrowIfNull(method);
            ArgumentNullException.ThrowIfNull(path);
            return _operations.TryGetValue(Key(method, path), out entry!);
        }

        internal static PlatformDeprecationRegistry Parse(string json)
        {
            ArgumentNullException.ThrowIfNull(json);
            if (Encoding.UTF8.GetByteCount(json) > MaximumRegistryBytes)
            {
                throw new InvalidDataException(
                    $"The Platform deprecation registry exceeds its {MaximumRegistryBytes}-byte bound.");
            }

            RegistryDocument document;
            try
            {
                document = JsonSerializer.Deserialize<RegistryDocument>(json, RegistryJson)
                    ?? throw new InvalidDataException("The Platform deprecation registry was empty.");
            }
            catch (JsonException exception)
            {
                throw new InvalidDataException("The Platform deprecation registry does not match schema version 1.", exception);
            }

            if (document.SchemaVersion != SchemaVersion)
            {
                throw new InvalidDataException(
                    $"Unsupported Platform deprecation registry schemaVersion {document.SchemaVersion}.");
            }

            if (document.Operations is null)
            {
                throw new InvalidDataException("The Platform deprecation registry must contain an operations array.");
            }

            if (document.Operations.Count > MaximumOperations)
            {
                throw new InvalidDataException(
                    $"The Platform deprecation registry exceeds its {MaximumOperations}-operation bound.");
            }

            var operations = new Dictionary<string, PlatformDeprecationEntry>(StringComparer.OrdinalIgnoreCase);
            foreach (var candidate in document.Operations)
            {
                if (candidate is null)
                {
                    throw new InvalidDataException("The Platform deprecation registry contains a null operation.");
                }

                var entry = ParseEntry(candidate);
                if (!operations.TryAdd(Key(entry.Method, entry.Path), entry))
                {
                    throw new InvalidDataException($"Duplicate Platform deprecation entry: {entry.Method} {entry.Path}.");
                }
            }

            return new PlatformDeprecationRegistry(operations);
        }

        private static PlatformDeprecationRegistry LoadShipped()
        {
            using var stream = typeof(PlatformDeprecationRegistry).Assembly.GetManifestResourceStream(ResourceName)
                ?? throw new InvalidOperationException($"Embedded Platform deprecation registry {ResourceName} is missing.");
            using var reader = new StreamReader(stream);
            return Parse(reader.ReadToEnd());
        }

        private static PlatformDeprecationEntry ParseEntry(RegistryEntry candidate)
        {
            var method = candidate.Method;
            var path = candidate.Path;
            var operation = $"{method ?? "<missing-method>"} {path ?? "<missing-path>"}";

            if (string.IsNullOrEmpty(method)
                || !string.Equals(method, method.Trim(), StringComparison.Ordinal)
                || !string.Equals(method, method.ToUpperInvariant(), StringComparison.Ordinal)
                || method.Any(character => character < 'A' || character > 'Z'))
            {
                throw new InvalidDataException($"{operation}: method must be a non-empty uppercase HTTP token.");
            }

            var routePrefix = "/" + PlatformConstants.RoutePrefix + "/";
            if (path is null
                || !string.Equals(path, path.Trim(), StringComparison.Ordinal)
                || !path.StartsWith(routePrefix, StringComparison.Ordinal)
                || path.Length > 256)
            {
                throw new InvalidDataException($"{operation}: path must be a literal Platform v1 operation path.");
            }

            var deprecatedAt = ParseUtc(candidate.DeprecatedAtUtc, operation, "deprecatedAtUtc");
            var sunsetAt = ParseUtc(candidate.SunsetAtUtc, operation, "sunsetAtUtc");
            if (sunsetAt - deprecatedAt < TimeSpan.FromDays(90))
            {
                throw new InvalidDataException(
                    $"{operation}: sunsetAtUtc must be at least 90 days after deprecatedAtUtc.");
            }

            var deprecatedIn = ParseVersion(candidate.DeprecatedInCanopyVersion, operation, "deprecatedInCanopyVersion");
            var removalNotBefore = ParseVersion(candidate.RemovalNotBeforeCanopyVersion, operation, "removalNotBeforeCanopyVersion");
            var minimumRemoval = new Version(deprecatedIn.Major, deprecatedIn.Minor + 1, 0, 0);
            if (removalNotBefore < minimumRemoval)
            {
                throw new InvalidDataException(
                    $"{operation}: removalNotBeforeCanopyVersion must be at least one Canopy minor after deprecatedInCanopyVersion ({minimumRemoval}).");
            }

            return new PlatformDeprecationEntry(
                method,
                path,
                deprecatedAt,
                sunsetAt,
                deprecatedIn,
                removalNotBefore);
        }

        private static DateTimeOffset ParseUtc(string? raw, string operation, string field)
        {
            var value = default(DateTimeOffset);
            var valid = raw is not null && DateTimeOffset.TryParseExact(
                raw,
                new[] { "yyyy-MM-dd'T'HH:mm:ss'Z'", "yyyy-MM-dd'T'HH:mm:ss.FFFFFFF'Z'" },
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
                out value);
            if (!valid || value.Offset != TimeSpan.Zero)
            {
                throw new InvalidDataException($"{operation}: {field} must be a canonical RFC 3339 UTC timestamp ending in Z.");
            }

            return value;
        }

        private static Version ParseVersion(string? raw, string operation, string field)
        {
            if (raw is null || !CanopyVersion.IsMatch(raw) || !Version.TryParse(raw, out var version))
            {
                throw new InvalidDataException($"{operation}: {field} must be a four-part stable Canopy version.");
            }

            return version;
        }

        private static string Key(string method, string path) => method.ToUpperInvariant() + " " + path;

        private sealed class RegistryDocument
        {
            [JsonPropertyName("schemaVersion")]
            public int SchemaVersion { get; set; }

            [JsonPropertyName("operations")]
            public List<RegistryEntry?>? Operations { get; set; }
        }

        private sealed class RegistryEntry
        {
            [JsonPropertyName("method")]
            public string? Method { get; set; }

            [JsonPropertyName("path")]
            public string? Path { get; set; }

            [JsonPropertyName("deprecatedAtUtc")]
            public string? DeprecatedAtUtc { get; set; }

            [JsonPropertyName("sunsetAtUtc")]
            public string? SunsetAtUtc { get; set; }

            [JsonPropertyName("deprecatedInCanopyVersion")]
            public string? DeprecatedInCanopyVersion { get; set; }

            [JsonPropertyName("removalNotBeforeCanopyVersion")]
            public string? RemovalNotBeforeCanopyVersion { get; set; }
        }
    }

    /// <summary>Canonical method/path identity derived from MVC-owned route metadata.</summary>
    internal static class PlatformOperationIdentity
    {
        internal static bool TryDescribe(
            ActionDescriptor descriptor,
            string requestMethod,
            out string method,
            out string path)
        {
            method = string.Empty;
            path = string.Empty;
            if (descriptor is not ControllerActionDescriptor controller
                || controller.MethodInfo.DeclaringType is not { } controllerType)
            {
                return false;
            }

            var combinedTemplate = controller.AttributeRouteInfo?.Template;
            if (!string.IsNullOrEmpty(combinedTemplate))
            {
                method = requestMethod.ToUpperInvariant();
                path = "/" + combinedTemplate.TrimStart('/');
                return true;
            }

            var prefix = controllerType.GetCustomAttribute<RouteAttribute>()?.Template;
            var verb = controller.MethodInfo.GetCustomAttributes<HttpMethodAttribute>()
                .FirstOrDefault(attribute => attribute.HttpMethods.Any(candidate =>
                    string.Equals(candidate, requestMethod, StringComparison.OrdinalIgnoreCase)));
            if (string.IsNullOrEmpty(prefix) || verb is null)
            {
                return false;
            }

            method = requestMethod.ToUpperInvariant();
            path = "/" + (string.IsNullOrEmpty(verb.Template) ? prefix : prefix + "/" + verb.Template);
            return true;
        }
    }
}
