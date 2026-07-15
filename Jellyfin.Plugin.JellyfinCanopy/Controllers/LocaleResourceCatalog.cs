using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;

namespace Jellyfin.Plugin.JellyfinCanopy.Controllers
{
    internal enum LocaleResolutionStatus
    {
        Invalid,
        Unsupported,
        Exact,
        RegionalFallback,
    }

    internal readonly record struct LocaleResolution(
        LocaleResolutionStatus Status,
        string NormalizedCode,
        LocaleResource? Resource);

    internal sealed class LocaleResource
    {
        public LocaleResource(string code, byte[] content)
        {
            Code = code;
            Content = content;
        }

        public string Code { get; }

        public byte[] Content { get; }
    }

    /// <summary>
    /// Strict parser for the canonical inventory's supported language shapes:
    /// two ASCII language letters, optionally followed by a hyphen and two
    /// ASCII region letters. Length is rejected before any normalized string is
    /// allocated.
    /// </summary>
    internal static class LocaleCodeParser
    {
        internal const int BaseCodeLength = 2;
        internal const int RegionalCodeLength = 5;

        public static bool TryNormalize(string? input, out string normalized)
        {
            normalized = string.Empty;
            if (input == null
                || (input.Length != BaseCodeLength && input.Length != RegionalCodeLength)
                || !IsAsciiLetter(input[0])
                || !IsAsciiLetter(input[1]))
            {
                return false;
            }

            if (input.Length == RegionalCodeLength
                && (input[2] != '-'
                    || !IsAsciiLetter(input[3])
                    || !IsAsciiLetter(input[4])))
            {
                return false;
            }

            if (IsCanonical(input))
            {
                normalized = input;
                return true;
            }

            normalized = string.Create(
                input.Length,
                input,
                static (characters, value) =>
                {
                    characters[0] = ToLowerAscii(value[0]);
                    characters[1] = ToLowerAscii(value[1]);
                    if (value.Length == RegionalCodeLength)
                    {
                        characters[2] = '-';
                        characters[3] = ToUpperAscii(value[3]);
                        characters[4] = ToUpperAscii(value[4]);
                    }
                });
            return true;
        }

        private static bool IsCanonical(string value)
            => IsLowerAscii(value[0])
                && IsLowerAscii(value[1])
                && (value.Length == BaseCodeLength
                    || (IsUpperAscii(value[3]) && IsUpperAscii(value[4])));

        private static bool IsAsciiLetter(char value)
            => IsLowerAscii(value) || IsUpperAscii(value);

        private static bool IsLowerAscii(char value)
            => value is >= 'a' and <= 'z';

        private static bool IsUpperAscii(char value)
            => value is >= 'A' and <= 'Z';

        private static char ToLowerAscii(char value)
            => IsUpperAscii(value) ? (char)(value + ('a' - 'A')) : value;

        private static char ToUpperAscii(char value)
            => IsLowerAscii(value) ? (char)(value - ('a' - 'A')) : value;
    }

    /// <summary>
    /// Startup-built, immutable locale catalog. The canonical manifest and the
    /// embedded resource inventory must agree exactly before any request can be
    /// served. Locale bytes are read once rather than reopening a resource for
    /// each anonymous request.
    /// </summary>
    internal sealed class LocaleResourceCatalog
    {
        private const string ManifestResource =
            "Jellyfin.Plugin.JellyfinCanopy.locale-manifest.json";
        private const string LocaleResourcePrefix =
            "Jellyfin.Plugin.JellyfinCanopy.js.locales.";
        private const string LocaleResourceSuffix = ".json";
        private const int MaximumLocaleCount = 128;
        private const int MaximumLocaleBytes = 1024 * 1024;

        private readonly FrozenDictionary<string, LocaleResource> _resources;

        private LocaleResourceCatalog(
            IReadOnlyList<string> supportedCodes,
            FrozenDictionary<string, LocaleResource> resources)
        {
            SupportedCodes = supportedCodes;
            _resources = resources;
        }

        public IReadOnlyList<string> SupportedCodes { get; }

        public static LocaleResourceCatalog Load(Assembly assembly)
        {
            ArgumentNullException.ThrowIfNull(assembly);

            LocaleManifest manifest;
            using (var stream = assembly.GetManifestResourceStream(ManifestResource)
                ?? throw new InvalidOperationException(
                    $"Embedded locale inventory is missing: {ManifestResource}"))
            {
                manifest = JsonSerializer.Deserialize<LocaleManifest>(stream)
                    ?? throw new InvalidOperationException(
                        "Embedded locale inventory is empty");
            }

            var localeCodes = manifest.Locales;
            if (localeCodes == null
                || localeCodes.Length == 0
                || localeCodes.Length > MaximumLocaleCount
                || manifest.BaseLocale == null)
            {
                throw new InvalidOperationException(
                    "Embedded locale inventory has invalid bounds");
            }

            var registered = new HashSet<string>(StringComparer.Ordinal);
            string? previous = null;
            foreach (var code in localeCodes)
            {
                if (!LocaleCodeParser.TryNormalize(code, out var normalized)
                    || !string.Equals(code, normalized, StringComparison.Ordinal))
                {
                    throw new InvalidOperationException(
                        $"Embedded locale inventory contains invalid code: {code}");
                }

                if (!registered.Add(code)
                    || (previous != null
                        && string.CompareOrdinal(previous, code) >= 0))
                {
                    throw new InvalidOperationException(
                        "Embedded locale inventory must be unique and sorted");
                }

                previous = code;
            }

            if (!LocaleCodeParser.TryNormalize(
                    manifest.BaseLocale,
                    out var normalizedBase)
                || !string.Equals(
                    manifest.BaseLocale,
                    normalizedBase,
                    StringComparison.Ordinal)
                || !registered.Contains(manifest.BaseLocale))
            {
                throw new InvalidOperationException(
                    "Embedded locale inventory has no registered base locale");
            }

            var embeddedCodes = assembly.GetManifestResourceNames()
                .Where(static name =>
                    name.StartsWith(LocaleResourcePrefix, StringComparison.Ordinal)
                    && name.EndsWith(LocaleResourceSuffix, StringComparison.Ordinal))
                .Select(static name => name.Substring(
                    LocaleResourcePrefix.Length,
                    name.Length
                        - LocaleResourcePrefix.Length
                        - LocaleResourceSuffix.Length))
                .ToHashSet(StringComparer.Ordinal);
            if (!registered.SetEquals(embeddedCodes))
            {
                throw new InvalidOperationException(
                    "Embedded locale resources do not match the canonical inventory");
            }

            var resources = new Dictionary<string, LocaleResource>(
                localeCodes.Length,
                StringComparer.Ordinal);
            foreach (var code in localeCodes)
            {
                var resourceName = LocaleResourcePrefix + code + LocaleResourceSuffix;
                using var stream = assembly.GetManifestResourceStream(resourceName)
                    ?? throw new InvalidOperationException(
                        $"Registered locale resource is missing: {code}.json");
                if (stream.Length <= 0 || stream.Length > MaximumLocaleBytes)
                {
                    throw new InvalidOperationException(
                        $"Registered locale resource has invalid size: {code}.json");
                }

                var content = new byte[checked((int)stream.Length)];
                stream.ReadExactly(content);
                resources.Add(code, new LocaleResource(code, content));
            }

            return new LocaleResourceCatalog(
                Array.AsReadOnly(localeCodes.ToArray()),
                resources.ToFrozenDictionary(StringComparer.Ordinal));
        }

        public LocaleResolution Resolve(string? requestedCode)
        {
            if (!LocaleCodeParser.TryNormalize(requestedCode, out var normalized))
            {
                return new LocaleResolution(
                    LocaleResolutionStatus.Invalid,
                    string.Empty,
                    null);
            }

            if (_resources.TryGetValue(normalized, out var exact))
            {
                return new LocaleResolution(
                    LocaleResolutionStatus.Exact,
                    normalized,
                    exact);
            }

            if (normalized.Length == LocaleCodeParser.RegionalCodeLength
                && _resources.TryGetValue(normalized[..2], out var fallback))
            {
                return new LocaleResolution(
                    LocaleResolutionStatus.RegionalFallback,
                    normalized,
                    fallback);
            }

            return new LocaleResolution(
                LocaleResolutionStatus.Unsupported,
                normalized,
                null);
        }

        private sealed class LocaleManifest
        {
            [JsonPropertyName("baseLocale")]
            public string? BaseLocale { get; init; }

            [JsonPropertyName("locales")]
            public string[]? Locales { get; init; }
        }
    }

    /// <summary>
    /// Bounds unexpected locale-miss logging both per normalized key/status and
    /// globally, so a high-cardinality anonymous stream cannot evade the cap.
    /// </summary>
    internal sealed class LocaleMissLogLimiter
    {
        internal static readonly TimeSpan Window = TimeSpan.FromHours(1);
        internal const int MaximumLogsPerWindow = 8;
        internal const int MaximumTrackedKeys = 256;

        private readonly object _gate = new();
        private readonly TimeProvider _timeProvider;
        private readonly BoundedTtlCache<LocaleMissKey, byte> _recentKeys;
        private DateTimeOffset _windowStarted;
        private int _logsInWindow;

        public LocaleMissLogLimiter(TimeProvider? timeProvider = null)
        {
            _timeProvider = timeProvider ?? TimeProvider.System;
            _windowStarted = _timeProvider.GetUtcNow();
            _recentKeys = new BoundedTtlCache<LocaleMissKey, byte>(
                MaximumTrackedKeys,
                MaximumTrackedKeys,
                timeProvider: _timeProvider,
                defaultTtl: () => Window);
        }

        public bool ShouldLog(string normalizedCode, int statusCode)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(normalizedCode);

            lock (_gate)
            {
                var now = _timeProvider.GetUtcNow();
                if (now < _windowStarted || now - _windowStarted >= Window)
                {
                    _windowStarted = now;
                    _logsInWindow = 0;
                    _recentKeys.Clear();
                }

                var key = new LocaleMissKey(normalizedCode, statusCode);
                if (!_recentKeys.TryAdd(key, 0, Window, out _))
                {
                    return false;
                }

                if (_logsInWindow >= MaximumLogsPerWindow)
                {
                    return false;
                }

                _logsInWindow++;
                return true;
            }
        }

        internal int TrackedKeyCount
        {
            get
            {
                lock (_gate)
                {
                    return _recentKeys.Count;
                }
            }
        }

        private readonly record struct LocaleMissKey(
            string NormalizedCode,
            int StatusCode);
    }
}
