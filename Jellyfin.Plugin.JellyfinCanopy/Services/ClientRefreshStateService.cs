using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Process-wide source of the identities and policy consumed by open Canopy
    /// browser/WebView clients. The Canopy identity is content-derived (not the
    /// assembly version), while the Jellyfin identity deliberately changes on
    /// every server process so clients survive same-version server replacements.
    /// </summary>
    public sealed class ClientRefreshStateService
    {
        private const string ClientManifestResource =
            "Jellyfin.Plugin.JellyfinCanopy.dist.client-manifest.json";

        private readonly IPluginConfigProvider _configProvider;
        private readonly string _serverId;
        private readonly string _canopyBuildId;
        private readonly string _jellyfinGeneration;
        private long _forceRevision;

        public ClientRefreshStateService(
            IPluginConfigProvider configProvider,
            string serverId,
            string jellyfinVersion)
            : this(
                configProvider,
                serverId,
                ResolveCanopyBuildId(typeof(ClientRefreshStateService).Assembly),
                CreateJellyfinGeneration(jellyfinVersion, Guid.NewGuid().ToString("N")))
        {
        }

        internal ClientRefreshStateService(
            IPluginConfigProvider configProvider,
            string serverId,
            string canopyBuildId,
            string jellyfinGeneration)
        {
            _configProvider = configProvider;
            _serverId = serverId;
            _canopyBuildId = canopyBuildId;
            _jellyfinGeneration = jellyfinGeneration;
        }

        /// <summary>Build one no-cache state snapshot from the current config.</summary>
        public ClientRefreshState GetState()
        {
            var snapshot = _configProvider.GetSnapshot();
            var config = snapshot.Configuration;
            var policy = config == null
                ? ClientRefreshPolicy.Disabled
                : new ClientRefreshPolicy(
                    NormalizeMode(config.ClientRefreshMode),
                    config.ClientRefreshOnCanopyUpdate,
                    config.ClientRefreshOnJellyfinUpdate,
                    config.ClientRefreshOnConfigChange,
                    Math.Clamp(config.ClientRefreshPollSeconds, 5, 3600),
                    Math.Clamp(config.ClientRefreshIdleSeconds, 0, 300));

            return new ClientRefreshState(
                SchemaVersion: 1,
                ServerId: _serverId,
                CanopyBuildId: _canopyBuildId,
                JellyfinGeneration: _jellyfinGeneration,
                ConfigurationRevision: snapshot.Revision,
                ForceRevision: Interlocked.Read(ref _forceRevision),
                Policy: policy);
        }

        /// <summary>
        /// Increment the explicit admin signal. It is intentionally process-local:
        /// a restart already changes <see cref="ClientRefreshState.JellyfinGeneration"/>.
        /// </summary>
        public long RequestRefresh()
            => Interlocked.Increment(ref _forceRevision);

        internal static string NormalizeMode(string? value)
            => value?.Trim().ToLowerInvariant() switch
            {
                "smart" => "Smart",
                "homeonly" => "HomeOnly",
                "notify" => "Notify",
                "disabled" => "Disabled",
                _ => "Disabled",
            };

        internal static string ResolveCanopyBuildId(Assembly assembly)
        {
            using (var stream = assembly.GetManifestResourceStream(ClientManifestResource))
            {
                if (stream != null)
                {
                    using var document = JsonDocument.Parse(stream);
                    if (document.RootElement.TryGetProperty("buildId", out var property))
                    {
                        var buildId = property.GetString();
                        if (IsLowerHexSha256(buildId))
                        {
                            return buildId!;
                        }
                    }
                }
            }

            // The production assembly always embeds the manifest. Keep a
            // content-derived fallback for unusual test/single-file hosts.
            var location = assembly.Location;
            if (!string.IsNullOrWhiteSpace(location) && File.Exists(location))
            {
                using var file = File.OpenRead(location);
                return Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
            }

            var moduleIdentity = assembly.ManifestModule.ModuleVersionId.ToString("N");
            return Convert.ToHexString(
                SHA256.HashData(Encoding.UTF8.GetBytes(moduleIdentity))).ToLowerInvariant();
        }

        internal static string CreateJellyfinGeneration(string? version, string processNonce)
            => Convert.ToHexString(
                SHA256.HashData(
                    Encoding.UTF8.GetBytes($"{version ?? "unknown"}\n{processNonce}")))
                .ToLowerInvariant();

        /// <summary>
        /// Dotted-numeric successor understood by the pre-Smart-Refresh client.
        /// Ordinary version consumers continue to receive the real assembly
        /// version; this is only used by the legacy heartbeat/push lane.
        /// </summary>
        internal static string CreateLegacyCompatibilityVersion(string? version)
        {
            var normalized = version?.Trim() ?? string.Empty;
            return normalized.Length > 0
                && normalized.Split('.').All(static part =>
                    part.Length > 0 && part.All(char.IsAsciiDigit))
                ? $"{normalized}.1"
                : normalized;
        }

        private static bool IsLowerHexSha256(string? value)
            => value?.Length == 64
                && value.All(static character =>
                    character is >= '0' and <= '9'
                    || character is >= 'a' and <= 'f');
    }

    public sealed record ClientRefreshState(
        int SchemaVersion,
        string ServerId,
        string CanopyBuildId,
        string JellyfinGeneration,
        long ConfigurationRevision,
        long ForceRevision,
        ClientRefreshPolicy Policy);

    public sealed record ClientRefreshPolicy(
        string Mode,
        bool OnCanopyUpdate,
        bool OnJellyfinUpdate,
        bool OnConfigChange,
        int PollSeconds,
        int IdleSeconds)
    {
        public static ClientRefreshPolicy Disabled { get; } =
            new("Disabled", false, false, false, 30, 5);
    }
}
