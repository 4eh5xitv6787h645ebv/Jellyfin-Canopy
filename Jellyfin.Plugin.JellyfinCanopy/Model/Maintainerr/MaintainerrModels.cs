using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Model.Maintainerr;

/// <summary>Small typed body accepted by the elevated unsaved-URL test route.</summary>
public sealed class MaintainerrTestRequest
{
    [JsonPropertyName("url")]
    public string Url { get; set; } = string.Empty;
}

public sealed class MaintainerrTestResponse
{
    [JsonPropertyName("ok")]
    public bool Ok { get; init; }

    [JsonPropertyName("ready")]
    public bool Ready { get; init; }

    [JsonPropertyName("version")]
    public string Version { get; init; } = string.Empty;

    [JsonPropertyName("jellyfinMode")]
    public bool JellyfinMode { get; init; }

    [JsonPropertyName("capable")]
    public bool Capable { get; init; }

    [JsonPropertyName("identityMatch")]
    public bool IdentityMatch { get; init; }

    [JsonPropertyName("identityWarning")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? IdentityWarning { get; init; }

    [JsonPropertyName("capabilities")]
    public IReadOnlyDictionary<string, bool> Capabilities { get; init; }
        = new Dictionary<string, bool>(StringComparer.Ordinal);

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }
}

public sealed class MaintainerrDashboardResponse
{
    [JsonPropertyName("status")]
    public required MaintainerrDashboardStatus Status { get; init; }

    [JsonPropertyName("collections")]
    public required IReadOnlyList<MaintainerrCollectionSummary> Collections { get; init; }

    [JsonPropertyName("storage")]
    public required MaintainerrStorageSummary Storage { get; init; }

    [JsonPropertyName("rules")]
    public required MaintainerrRulesSummary Rules { get; init; }

    [JsonPropertyName("overlays")]
    public required MaintainerrOverlaySummary Overlays { get; init; }

    [JsonPropertyName("links")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public MaintainerrAdminLinks? Links { get; init; }
}

public sealed class MaintainerrDashboardStatus
{
    [JsonPropertyName("ready")]
    public bool Ready { get; init; }

    [JsonPropertyName("degraded")]
    public bool Degraded { get; init; }

    [JsonPropertyName("version")]
    public string Version { get; init; } = string.Empty;

    [JsonPropertyName("jellyfinMode")]
    public bool JellyfinMode { get; init; }

    [JsonPropertyName("capable")]
    public bool Capable { get; init; }

    [JsonPropertyName("identityMatch")]
    public bool IdentityMatch { get; init; }

    [JsonPropertyName("identityWarning")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? IdentityWarning { get; init; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }
}

public sealed class MaintainerrCollectionSummary
{
    [JsonPropertyName("id")]
    public int Id { get; init; }

    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("isActive")]
    public bool IsActive { get; init; }

    [JsonPropertyName("mediaCount")]
    public int MediaCount { get; init; }

    [JsonPropertyName("deleteAfterDays")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? DeleteAfterDays { get; init; }

    [JsonPropertyName("manualCollection")]
    public bool ManualCollection { get; init; }

    [JsonPropertyName("handledMediaAmount")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? HandledMediaAmount { get; init; }

    [JsonPropertyName("lastDurationInSeconds")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? LastDurationInSeconds { get; init; }

    [JsonPropertyName("totalSizeBytes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? TotalSizeBytes { get; init; }

    [JsonPropertyName("handledMediaSizeBytes")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? HandledMediaSizeBytes { get; init; }

    [JsonPropertyName("href")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Href { get; init; }
}

public sealed class MaintainerrStorageSummary
{
    [JsonPropertyName("state")]
    public required string State { get; init; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }

    [JsonPropertyName("generatedAt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? GeneratedAt { get; init; }

    [JsonPropertyName("collectionSummary")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, long>? CollectionSummary { get; init; }

    [JsonPropertyName("cleanupTotals")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyDictionary<string, long>? CleanupTotals { get; init; }

    [JsonPropertyName("reclaimableUsingFallback")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? ReclaimableUsingFallback { get; init; }
}

public sealed class MaintainerrRulesSummary
{
    [JsonPropertyName("state")]
    public required string State { get; init; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }

    [JsonPropertyName("count")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Count { get; init; }

    [JsonPropertyName("processingQueue")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? ProcessingQueue { get; init; }

    [JsonPropertyName("executing")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Executing { get; init; }

    [JsonPropertyName("pendingCount")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? PendingCount { get; init; }

    [JsonPropertyName("queueCount")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? QueueCount { get; init; }
}

public sealed class MaintainerrOverlaySummary
{
    [JsonPropertyName("state")]
    public required string State { get; init; }

    [JsonPropertyName("error")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Error { get; init; }

    [JsonPropertyName("status")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Status { get; init; }

    [JsonPropertyName("lastRun")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LastRun { get; init; }
}

public sealed class MaintainerrAdminLinks
{
    [JsonPropertyName("overview")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Overview { get; init; }

    [JsonPropertyName("rules")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Rules { get; init; }

    [JsonPropertyName("storageMetrics")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? StorageMetrics { get; init; }
}

public sealed class MaintainerrCollectionContentResponse
{
    [JsonPropertyName("page")]
    public int Page { get; init; }

    [JsonPropertyName("size")]
    public int Size { get; init; }

    [JsonPropertyName("totalSize")]
    public int TotalSize { get; init; }

    [JsonPropertyName("items")]
    public IReadOnlyList<MaintainerrCollectionContentItem> Items { get; init; }
        = Array.Empty<MaintainerrCollectionContentItem>();
}

public sealed class MaintainerrCollectionContentItem
{
    [JsonPropertyName("id")]
    public int Id { get; init; }

    [JsonPropertyName("title")]
    public string Title { get; init; } = string.Empty;

    [JsonPropertyName("type")]
    public string Type { get; init; } = string.Empty;

    [JsonPropertyName("href")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Href { get; init; }
}

public sealed class MaintainerrUserItemStatusResponse
{
    [JsonPropertyName("protectedFromCleanup")]
    public bool ProtectedFromCleanup { get; init; }

    [JsonPropertyName("manuallyManaged")]
    public bool ManuallyManaged { get; init; }
}

public sealed class MaintainerrAdminItemStatusResponse
{
    [JsonPropertyName("protectedFromCleanup")]
    public bool ProtectedFromCleanup { get; init; }

    [JsonPropertyName("manuallyManaged")]
    public bool ManuallyManaged { get; init; }

    [JsonPropertyName("excludedFrom")]
    public IReadOnlyList<MaintainerrItemStatusLink> ExcludedFrom { get; init; }
        = Array.Empty<MaintainerrItemStatusLink>();

    [JsonPropertyName("manuallyAddedTo")]
    public IReadOnlyList<MaintainerrItemStatusLink> ManuallyAddedTo { get; init; }
        = Array.Empty<MaintainerrItemStatusLink>();
}

public sealed class MaintainerrItemStatusLink
{
    [JsonPropertyName("label")]
    public string Label { get; init; } = string.Empty;

    [JsonPropertyName("href")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Href { get; init; }
}

public sealed class MaintainerrErrorResponse
{
    public MaintainerrErrorResponse(string error)
    {
        Error = error;
    }

    [JsonPropertyName("error")]
    public string Error { get; }
}
