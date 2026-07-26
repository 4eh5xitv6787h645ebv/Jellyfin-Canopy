using System.Security.Cryptography;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Maintainerr;

internal enum MaintainerrIntegrationState
{
    Active,
    Disabled,
    ConfigurationUnavailable,
    InvalidUrl,
    ConfigurationChanged,
}

/// <summary>
/// Immutable, generation-owned authorization for saved Maintainerr reads.
/// Inactive snapshots retain no internal target.
/// </summary>
internal sealed class MaintainerrIntegrationSnapshot
{
    private readonly byte[]? _configurationDigest;

    private MaintainerrIntegrationSnapshot(
        MaintainerrIntegrationState state,
        long revision,
        byte[]? configurationDigest,
        string internalUrl,
        string externalUrl,
        string urlMappings,
        bool pageEnabled,
        bool itemStatusEnabled,
        bool itemStatusForUsers)
    {
        State = state;
        ConfigurationRevision = revision;
        _configurationDigest = configurationDigest;
        InternalUrl = internalUrl;
        ExternalUrl = externalUrl;
        UrlMappings = urlMappings;
        PageEnabled = pageEnabled;
        ItemStatusEnabled = itemStatusEnabled;
        ItemStatusForUsers = itemStatusForUsers;
    }

    public MaintainerrIntegrationState State { get; }

    public bool IsActive => State == MaintainerrIntegrationState.Active;

    public long ConfigurationRevision { get; }

    public string InternalUrl { get; }

    public string ExternalUrl { get; }

    public string UrlMappings { get; }

    public bool PageEnabled { get; }

    public bool ItemStatusEnabled { get; }

    public bool ItemStatusForUsers { get; }

    public string GenerationIdentity => _configurationDigest == null
        ? string.Empty
        : $"{ConfigurationRevision}:{Convert.ToHexString(_configurationDigest)}";

    public bool IsCurrent(IPluginConfigProvider provider)
    {
        if (!IsActive || _configurationDigest == null)
        {
            return false;
        }

        try
        {
            var current = provider.GetSnapshot();
            if (current.Configuration == null || current.Revision != ConfigurationRevision)
            {
                return false;
            }

            var digest = SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(current.Configuration));
            return CryptographicOperations.FixedTimeEquals(_configurationDigest, digest);
        }
        catch
        {
            return false;
        }
    }

    public bool ContainsTarget(Uri? target)
    {
        if (!IsActive
            || target == null
            || !target.IsAbsoluteUri
            || !Uri.TryCreate(InternalUrl, UriKind.Absolute, out var source)
            || !string.Equals(source.Scheme, target.Scheme, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(source.IdnHost, target.IdnHost, StringComparison.OrdinalIgnoreCase)
            || source.Port != target.Port)
        {
            return false;
        }

        var sourcePath = source.AbsolutePath.TrimEnd('/');
        var targetPath = target.AbsolutePath.TrimEnd('/');
        return string.Equals(targetPath, sourcePath, StringComparison.Ordinal)
            || targetPath.StartsWith(sourcePath + "/", StringComparison.Ordinal);
    }

    public static MaintainerrIntegrationSnapshot Capture(IPluginConfigProvider provider)
    {
        PluginConfigurationSnapshot live;
        try
        {
            live = provider.GetSnapshot();
        }
        catch
        {
            return Inactive(MaintainerrIntegrationState.ConfigurationUnavailable, 0);
        }

        if (live.Configuration == null)
        {
            return Inactive(MaintainerrIntegrationState.ConfigurationUnavailable, live.Revision);
        }

        byte[] serialized;
        PluginConfiguration owned;
        try
        {
            serialized = JsonSerializer.SerializeToUtf8Bytes(live.Configuration);
            owned = JsonSerializer.Deserialize<PluginConfiguration>(serialized)
                ?? throw new JsonException("Maintainerr configuration snapshot was empty.");
        }
        catch
        {
            return Inactive(MaintainerrIntegrationState.ConfigurationChanged, live.Revision);
        }

        if (!owned.MaintainerrEnabled)
        {
            return Inactive(MaintainerrIntegrationState.Disabled, live.Revision);
        }

        if (!ServiceUrlResolver.TryNormalizeHttpBaseUrl(owned.MaintainerrUrl, out var internalUrl))
        {
            return Inactive(MaintainerrIntegrationState.InvalidUrl, live.Revision);
        }

        _ = ServiceUrlResolver.TryNormalizeHttpBaseUrl(
            owned.MaintainerrExternalUrl,
            out var externalUrl);
        var snapshot = new MaintainerrIntegrationSnapshot(
            MaintainerrIntegrationState.Active,
            live.Revision,
            SHA256.HashData(serialized),
            internalUrl,
            externalUrl,
            ServiceUrlResolver.SanitizeUrlMappings(owned.MaintainerrUrlMappings),
            owned.MaintainerrPageEnabled,
            owned.MaintainerrItemStatusEnabled,
            owned.MaintainerrItemStatusForUsers);

        return snapshot.IsCurrent(provider)
            ? snapshot
            : Inactive(MaintainerrIntegrationState.ConfigurationChanged, provider.ConfigurationRevision);
    }

    private static MaintainerrIntegrationSnapshot Inactive(
        MaintainerrIntegrationState state,
        long revision)
        => new(
            state,
            revision,
            configurationDigest: null,
            string.Empty,
            string.Empty,
            string.Empty,
            pageEnabled: false,
            itemStatusEnabled: false,
            itemStatusForUsers: false);
}
