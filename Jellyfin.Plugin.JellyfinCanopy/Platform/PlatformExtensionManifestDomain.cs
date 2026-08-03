using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>Frozen byte, depth, count and compatibility bounds for manifest v1.</summary>
    internal static class PlatformExtensionManifestBounds
    {
        internal const int MaximumDocumentBytes = 256 * 1024;
        internal const int MaximumJsonDepth = 16;
        internal const int MaximumIdBytes = 128;
        internal const int MaximumVersionBytes = 64;
        internal const int MaximumDisplayNameBytes = 96;
        internal const int MaximumDescriptionBytes = 512;
        internal const int MaximumCompatibilityMajor = 65535;
        internal const int MaximumRequestedCapabilities = PlatformCapabilityVocabulary.MaximumCapabilityCount;
    }

    /// <summary>Closed rejection reasons for the bounded Platform extension manifest parser.</summary>
    internal enum PlatformExtensionManifestRejectionReason
    {
        None = 0,
        MissingDocument = 1,
        DocumentTooLarge = 2,
        InvalidUtf8 = 3,
        InvalidJson = 4,
        DuplicateProperty = 5,
        UnknownProperty = 6,
        MissingProperty = 7,
        InvalidPropertyType = 8,
        UnsupportedSchemaVersion = 9,
        InvalidIdentifier = 10,
        InvalidPluginId = 11,
        InvalidVersion = 12,
        InvalidKind = 13,
        InvalidDisplayName = 14,
        InvalidDescription = 15,
        InvalidPlatformRange = 16,
        InvalidHostRange = 17,
        InvalidRequestedCapabilities = 18,
        IncompatibleRequestedCapability = 19,
    }

    /// <summary>An immutable inclusive Platform protocol-major compatibility range.</summary>
    internal readonly struct PlatformExtensionProtocolRange
    {
        internal PlatformExtensionProtocolRange(int min, int max)
        {
            Min = min;
            Max = max;
        }

        internal int Min { get; }

        internal int Max { get; }
    }

    /// <summary>An immutable inclusive Jellyfin host-major compatibility range.</summary>
    internal readonly struct PlatformExtensionHostRange
    {
        internal PlatformExtensionHostRange(int minMajor, int maxMajor)
        {
            MinMajor = minMajor;
            MaxMajor = maxMajor;
        }

        internal int MinMajor { get; }

        internal int MaxMajor { get; }
    }

    /// <summary>
    /// One validated immutable installed-provider manifest. This value requests
    /// capabilities only; it is not installation evidence, approval or authority.
    /// </summary>
    internal sealed class PlatformExtensionManifest
    {
        private PlatformExtensionManifest(
            int schemaVersion,
            string id,
            Guid pluginId,
            Version version,
            PlatformActorKind kind,
            string displayName,
            string? description,
            PlatformExtensionProtocolRange platformRange,
            PlatformExtensionHostRange hostRange,
            PlatformRequestedCapabilitySet requestedCapabilities,
            PlatformManifestFingerprint fingerprint)
        {
            SchemaVersion = schemaVersion;
            Id = id;
            PluginId = pluginId;
            Version = version;
            Kind = kind;
            DisplayName = displayName;
            Description = description;
            PlatformRange = platformRange;
            HostRange = hostRange;
            RequestedCapabilities = requestedCapabilities;
            Fingerprint = fingerprint;
        }

        internal int SchemaVersion { get; }

        internal string Id { get; }

        internal Guid PluginId { get; }

        internal Version Version { get; }

        internal PlatformActorKind Kind { get; }

        internal string DisplayName { get; }

        internal string? Description { get; }

        internal PlatformExtensionProtocolRange PlatformRange { get; }

        internal PlatformExtensionHostRange HostRange { get; }

        internal PlatformRequestedCapabilitySet RequestedCapabilities { get; }

        internal PlatformManifestFingerprint Fingerprint { get; }

        internal static PlatformExtensionManifest EstablishValidatedManifest(
            int schemaVersion,
            string id,
            Guid pluginId,
            Version version,
            PlatformActorKind kind,
            string displayName,
            string? description,
            PlatformExtensionProtocolRange platformRange,
            PlatformExtensionHostRange hostRange,
            PlatformRequestedCapabilitySet requestedCapabilities,
            PlatformManifestFingerprint fingerprint) => new(
                schemaVersion,
                id,
                pluginId,
                version,
                kind,
                displayName,
                description,
                platformRange,
                hostRange,
                requestedCapabilities,
                fingerprint);
    }

    /// <summary>Pure bounded parser and canonical semantic fingerprint owner.</summary>
    internal static class PlatformExtensionManifestParser
    {
        internal const string ManifestFileName = "jellyfin-canopy-extension.json";
        internal const string SchemaId = "urn:jellyfin-canopy:platform:v1:extension-manifest";
        internal const int SchemaVersion = 1;
        internal const int MaximumIdentifierSegmentLength = 64;

        internal const string FingerprintAlgorithm = "sha-256";
        internal const string FingerprintDomain = "jellyfin-canopy-extension-manifest-v1";
        private static readonly UTF8Encoding StrictUtf8 = new(false, true);
        private static readonly HashSet<string> RootProperties = new(StringComparer.Ordinal)
        {
            "schemaVersion",
            "id",
            "pluginId",
            "version",
            "kind",
            "displayName",
            "description",
            "platform",
            "host",
            "requestedCapabilities",
        };

        private static readonly string[] RequiredRootProperties =
        {
            "schemaVersion",
            "id",
            "pluginId",
            "version",
            "kind",
            "displayName",
            "platform",
            "host",
            "requestedCapabilities",
        };

        internal static bool TryParse(
            byte[]? utf8Json,
            out PlatformExtensionManifest? manifest,
            out PlatformExtensionManifestRejectionReason reason)
        {
            manifest = null;
            reason = PlatformExtensionManifestRejectionReason.None;
            if (utf8Json is null || utf8Json.Length == 0)
            {
                reason = PlatformExtensionManifestRejectionReason.MissingDocument;
                return false;
            }

            if (utf8Json.Length > PlatformExtensionManifestBounds.MaximumDocumentBytes)
            {
                reason = PlatformExtensionManifestRejectionReason.DocumentTooLarge;
                return false;
            }

            if (utf8Json.Length >= 3
                && utf8Json[0] == 0xEF
                && utf8Json[1] == 0xBB
                && utf8Json[2] == 0xBF)
            {
                reason = PlatformExtensionManifestRejectionReason.InvalidUtf8;
                return false;
            }

            try
            {
                _ = StrictUtf8.GetString(utf8Json);
            }
            catch (DecoderFallbackException)
            {
                reason = PlatformExtensionManifestRejectionReason.InvalidUtf8;
                return false;
            }

            JsonDocument document;
            try
            {
                document = JsonDocument.Parse(
                    utf8Json,
                    new JsonDocumentOptions
                    {
                        AllowTrailingCommas = false,
                        CommentHandling = JsonCommentHandling.Disallow,
                        MaxDepth = PlatformExtensionManifestBounds.MaximumJsonDepth,
                    });
            }
            catch (JsonException)
            {
                reason = PlatformExtensionManifestRejectionReason.InvalidJson;
                return false;
            }

            using (document)
            {
                var root = document.RootElement;
                if (root.ValueKind != JsonValueKind.Object)
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidPropertyType;
                    return false;
                }

                if (!HasExactProperties(root, RootProperties, RequiredRootProperties, out reason))
                {
                    return false;
                }

                if (!TryReadInteger(root, "schemaVersion", out var schemaVersion))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidPropertyType;
                    return false;
                }

                if (schemaVersion != SchemaVersion)
                {
                    reason = PlatformExtensionManifestRejectionReason.UnsupportedSchemaVersion;
                    return false;
                }

                if (!TryReadString(root, "id", out var id) || !IsValidIdentifier(id))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidIdentifier;
                    return false;
                }

                if (!TryReadString(root, "pluginId", out var pluginIdText)
                    || !Guid.TryParseExact(pluginIdText, "D", out var pluginId)
                    || pluginId == Guid.Empty
                    || !string.Equals(pluginId.ToString("D"), pluginIdText, StringComparison.Ordinal))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidPluginId;
                    return false;
                }

                if (!TryReadString(root, "version", out var versionText)
                    || Encoding.UTF8.GetByteCount(versionText) > PlatformExtensionManifestBounds.MaximumVersionBytes
                    || !IsAsciiVersion(versionText)
                    || !Version.TryParse(versionText, out var version)
                    || version.Major < 0
                    || version.Minor < 0
                    || !string.Equals(version.ToString(), versionText, StringComparison.Ordinal))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidVersion;
                    return false;
                }

                if (!TryReadString(root, "kind", out var kindText)
                    || !string.Equals(
                        kindText,
                        PlatformActorKindVocabulary.TokenFor(PlatformActorKind.InstalledProvider),
                        StringComparison.Ordinal))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidKind;
                    return false;
                }

                if (!TryReadString(root, "displayName", out var displayName)
                    || !IsBoundedDisplayText(
                        displayName,
                        1,
                        PlatformExtensionManifestBounds.MaximumDisplayNameBytes))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidDisplayName;
                    return false;
                }

                string? description = null;
                if (root.TryGetProperty("description", out var descriptionElement))
                {
                    if (descriptionElement.ValueKind != JsonValueKind.String
                        || (description = descriptionElement.GetString()) is null
                        || !IsBoundedDisplayText(
                            description,
                            0,
                            PlatformExtensionManifestBounds.MaximumDescriptionBytes))
                    {
                        reason = PlatformExtensionManifestRejectionReason.InvalidDescription;
                        return false;
                    }
                }

                if (!TryReadProtocolRange(root.GetProperty("platform"), out var platformRange, out reason))
                {
                    if (reason is PlatformExtensionManifestRejectionReason.None
                        or PlatformExtensionManifestRejectionReason.MissingProperty
                        or PlatformExtensionManifestRejectionReason.InvalidPropertyType)
                    {
                        reason = PlatformExtensionManifestRejectionReason.InvalidPlatformRange;
                    }

                    return false;
                }

                if (!TryReadHostRange(root.GetProperty("host"), out var hostRange, out reason))
                {
                    if (reason is PlatformExtensionManifestRejectionReason.None
                        or PlatformExtensionManifestRejectionReason.MissingProperty
                        or PlatformExtensionManifestRejectionReason.InvalidPropertyType)
                    {
                        reason = PlatformExtensionManifestRejectionReason.InvalidHostRange;
                    }

                    return false;
                }

                var requestedElement = root.GetProperty("requestedCapabilities");
                if (requestedElement.ValueKind != JsonValueKind.Array
                    || requestedElement.GetArrayLength()
                        > PlatformExtensionManifestBounds.MaximumRequestedCapabilities)
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidRequestedCapabilities;
                    return false;
                }

                var requestedValues = new List<string>(requestedElement.GetArrayLength());
                foreach (var value in requestedElement.EnumerateArray())
                {
                    if (value.ValueKind != JsonValueKind.String || value.GetString() is not { } token)
                    {
                        reason = PlatformExtensionManifestRejectionReason.InvalidRequestedCapabilities;
                        return false;
                    }

                    requestedValues.Add(token);
                }

                if (!PlatformRequestedCapabilitySet.TryCreate(requestedValues, out var requestedCapabilities))
                {
                    reason = PlatformExtensionManifestRejectionReason.InvalidRequestedCapabilities;
                    return false;
                }

                if (requestedCapabilities.Capabilities.Any(definition =>
                        !definition.AllowedActorKinds.Contains(PlatformActorKind.InstalledProvider)))
                {
                    reason = PlatformExtensionManifestRejectionReason.IncompatibleRequestedCapability;
                    return false;
                }

                var fingerprint = PlatformManifestFingerprint.EstablishValidatedManifestFingerprint(
                    ComputeFingerprint(
                        schemaVersion,
                        id,
                        pluginId,
                        version,
                        displayName,
                        description,
                        platformRange,
                        hostRange,
                        requestedCapabilities));
                manifest = PlatformExtensionManifest.EstablishValidatedManifest(
                    schemaVersion,
                    id,
                    pluginId,
                    version,
                    PlatformActorKind.InstalledProvider,
                    displayName,
                    description,
                    platformRange,
                    hostRange,
                    requestedCapabilities,
                    fingerprint);
                return true;
            }
        }

        private static bool TryReadProtocolRange(
            JsonElement element,
            out PlatformExtensionProtocolRange range,
            out PlatformExtensionManifestRejectionReason reason)
        {
            range = default;
            reason = PlatformExtensionManifestRejectionReason.None;
            var properties = new HashSet<string>(StringComparer.Ordinal) { "min", "max" };
            if (element.ValueKind != JsonValueKind.Object
                || !HasExactProperties(element, properties, ["min", "max"], out reason)
                || !TryReadInteger(element, "min", out var min)
                || !TryReadInteger(element, "max", out var max)
                || !IsValidRange(min, max))
            {
                return false;
            }

            range = new PlatformExtensionProtocolRange(min, max);
            return true;
        }

        private static bool TryReadHostRange(
            JsonElement element,
            out PlatformExtensionHostRange range,
            out PlatformExtensionManifestRejectionReason reason)
        {
            range = default;
            reason = PlatformExtensionManifestRejectionReason.None;
            var properties = new HashSet<string>(StringComparer.Ordinal) { "minMajor", "maxMajor" };
            if (element.ValueKind != JsonValueKind.Object
                || !HasExactProperties(element, properties, ["minMajor", "maxMajor"], out reason)
                || !TryReadInteger(element, "minMajor", out var min)
                || !TryReadInteger(element, "maxMajor", out var max)
                || !IsValidRange(min, max))
            {
                return false;
            }

            range = new PlatformExtensionHostRange(min, max);
            return true;
        }

        private static bool HasExactProperties(
            JsonElement element,
            HashSet<string> allowed,
            IReadOnlyList<string> required,
            out PlatformExtensionManifestRejectionReason reason)
        {
            reason = PlatformExtensionManifestRejectionReason.None;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in element.EnumerateObject())
            {
                if (!seen.Add(property.Name))
                {
                    reason = PlatformExtensionManifestRejectionReason.DuplicateProperty;
                    return false;
                }

                if (!allowed.Contains(property.Name))
                {
                    reason = PlatformExtensionManifestRejectionReason.UnknownProperty;
                    return false;
                }
            }

            if (required.Any(name => !seen.Contains(name)))
            {
                reason = PlatformExtensionManifestRejectionReason.MissingProperty;
                return false;
            }

            return true;
        }

        private static bool TryReadString(JsonElement element, string name, out string value)
        {
            value = string.Empty;
            var property = element.GetProperty(name);
            if (property.ValueKind != JsonValueKind.String || property.GetString() is not { } text)
            {
                return false;
            }

            value = text;
            return true;
        }

        private static bool TryReadInteger(JsonElement element, string name, out int value)
        {
            value = 0;
            var property = element.GetProperty(name);
            return property.ValueKind == JsonValueKind.Number && property.TryGetInt32(out value);
        }

        private static bool IsValidRange(int min, int max) =>
            min >= 1 && max >= min && max <= PlatformExtensionManifestBounds.MaximumCompatibilityMajor;

        private static bool IsValidIdentifier(string value)
        {
            if (value.Length is < 3 or > PlatformExtensionManifestBounds.MaximumIdBytes)
            {
                return false;
            }

            var segments = value.Split('.');
            if (segments.Length < 2)
            {
                return false;
            }

            foreach (var segment in segments)
            {
                if (segment.Length is < 1 or > MaximumIdentifierSegmentLength
                    || segment[0] is < 'a' or > 'z')
                {
                    return false;
                }

                for (var index = 1; index < segment.Length; index++)
                {
                    var character = segment[index];
                    var asciiLetterOrDigit = character is >= 'a' and <= 'z' or >= '0' and <= '9';
                    if (asciiLetterOrDigit)
                    {
                        continue;
                    }

                    if (character != '-'
                        || segment[index - 1] == '-'
                        || index == segment.Length - 1)
                    {
                        return false;
                    }
                }
            }

            return true;
        }

        private static bool IsAsciiVersion(string value)
        {
            var components = 1;
            foreach (var character in value)
            {
                if (character == '.')
                {
                    components++;
                }
                else if (character is < '0' or > '9')
                {
                    return false;
                }
            }

            return components is >= 2 and <= 4;
        }

        private static bool IsBoundedDisplayText(string value, int minimumBytes, int maximumBytes)
        {
            var bytes = Encoding.UTF8.GetByteCount(value);
            if (bytes < minimumBytes
                || bytes > maximumBytes
                || !string.Equals(value, value.Trim(), StringComparison.Ordinal))
            {
                return false;
            }

            foreach (var rune in value.EnumerateRunes())
            {
                var category = Rune.GetUnicodeCategory(rune);
                if (category is UnicodeCategory.Control or UnicodeCategory.Format)
                {
                    return false;
                }
            }

            return true;
        }

        private static string ComputeFingerprint(
            int schemaVersion,
            string id,
            Guid pluginId,
            Version version,
            string displayName,
            string? description,
            PlatformExtensionProtocolRange platformRange,
            PlatformExtensionHostRange hostRange,
            PlatformRequestedCapabilitySet requestedCapabilities)
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            Append(hash, FingerprintDomain);
            Append(hash, schemaVersion.ToString(CultureInfo.InvariantCulture));
            Append(hash, id);
            Append(hash, pluginId.ToString("D"));
            Append(hash, version.ToString());
            Append(hash, PlatformActorKindVocabulary.TokenFor(PlatformActorKind.InstalledProvider)!);
            Append(hash, displayName);
            Append(hash, description is null ? "0" : "1");
            if (description is not null)
            {
                Append(hash, description);
            }

            Append(hash, platformRange.Min.ToString(CultureInfo.InvariantCulture));
            Append(hash, platformRange.Max.ToString(CultureInfo.InvariantCulture));
            Append(hash, hostRange.MinMajor.ToString(CultureInfo.InvariantCulture));
            Append(hash, hostRange.MaxMajor.ToString(CultureInfo.InvariantCulture));
            Append(hash, requestedCapabilities.Capabilities.Length.ToString(CultureInfo.InvariantCulture));
            foreach (var capability in requestedCapabilities.Capabilities)
            {
                Append(hash, capability.Id.Value);
            }

            return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        }

        private static void Append(IncrementalHash hash, string value)
        {
            var bytes = Encoding.UTF8.GetBytes(value);
            Span<byte> length = stackalloc byte[sizeof(int)];
            BinaryPrimitives.WriteInt32BigEndian(length, bytes.Length);
            hash.AppendData(length);
            hash.AppendData(bytes);
        }
    }
}
