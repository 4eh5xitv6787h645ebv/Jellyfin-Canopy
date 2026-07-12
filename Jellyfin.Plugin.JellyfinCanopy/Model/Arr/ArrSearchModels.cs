using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JellyfinCanopy.Model.Arr
{
    // Wire DTOs for the Search / Interactive Search feature. All property names are pinned with
    // [JsonPropertyName] so the payload is lowerCamel regardless of the host's JSON naming policy,
    // matching the existing arr client convention (arr-links / queue / calendar). None of these
    // ever carry an instance ApiKey.

    /// <summary>What actions the client should offer for a resolved item, plus per-instance status.</summary>
    public sealed class ArrContextDto
    {
        /// <summary>"movie" | "series" | "season" | "episode" | "unknown".</summary>
        [JsonPropertyName("kind")] public string Kind { get; set; } = "unknown";

        /// <summary>"sonarr" | "radarr" | null.</summary>
        [JsonPropertyName("service")] public string? Service { get; set; }

        [JsonPropertyName("name")] public string? Name { get; set; }

        [JsonPropertyName("seasonNumber")] public int? SeasonNumber { get; set; }

        [JsonPropertyName("episodeNumber")] public int? EpisodeNumber { get; set; }

        /// <summary>True when at least one enabled instance of the right service is configured.</summary>
        [JsonPropertyName("serviceConfigured")] public bool ServiceConfigured { get; set; }

        /// <summary>Interactive (manual release list) is supported for movie / season / episode, not whole series.</summary>
        [JsonPropertyName("supportsInteractive")] public bool SupportsInteractive { get; set; }

        /// <summary>Whether the admin has enabled the management actions (monitor / add).</summary>
        [JsonPropertyName("canManage")] public bool CanManage { get; set; }

        /// <summary>Instances that already track this item (search / interactive / monitor apply here).</summary>
        [JsonPropertyName("targets")] public List<ArrTargetDto> Targets { get; set; } = new();

        /// <summary>Enabled instances that do NOT yet track this item (Add applies here). Movies/series only.</summary>
        [JsonPropertyName("addableInstances")] public List<string> AddableInstances { get; set; } = new();

        /// <summary>Per-instance fetch errors, so the UI can explain a partial result.</summary>
        [JsonPropertyName("errors")] public List<ArrErrorDto> Errors { get; set; } = new();
    }

    /// <summary>One instance that tracks the item, with the arr internal ids + monitor/file state.</summary>
    public sealed class ArrTargetDto
    {
        [JsonPropertyName("instanceName")] public string InstanceName { get; set; } = string.Empty;

        [JsonPropertyName("service")] public string Service { get; set; } = string.Empty;

        /// <summary>Sonarr seriesId / Radarr movieId.</summary>
        [JsonPropertyName("arrId")] public int ArrId { get; set; }

        /// <summary>Sonarr episodeId when the resolved item is a single episode.</summary>
        [JsonPropertyName("episodeId")] public int? EpisodeId { get; set; }

        [JsonPropertyName("monitored")] public bool Monitored { get; set; }

        /// <summary>Whether the targeted unit (movie/episode) has a file; for series/season this is a summary flag.</summary>
        [JsonPropertyName("hasFile")] public bool HasFile { get; set; }
    }

    /// <summary>A normalized release row for the Interactive Search picker.</summary>
    public sealed class ArrReleaseDto
    {
        [JsonPropertyName("guid")] public string Guid { get; set; } = string.Empty;
        [JsonPropertyName("indexerId")] public int IndexerId { get; set; }
        [JsonPropertyName("indexer")] public string? Indexer { get; set; }
        [JsonPropertyName("title")] public string? Title { get; set; }
        [JsonPropertyName("quality")] public string? Quality { get; set; }
        [JsonPropertyName("qualityWeight")] public int QualityWeight { get; set; }
        [JsonPropertyName("size")] public long Size { get; set; }
        [JsonPropertyName("ageHours")] public double AgeHours { get; set; }
        [JsonPropertyName("seeders")] public int? Seeders { get; set; }
        [JsonPropertyName("leechers")] public int? Leechers { get; set; }
        /// <summary>"usenet" | "torrent".</summary>
        [JsonPropertyName("protocol")] public string? Protocol { get; set; }
        [JsonPropertyName("approved")] public bool Approved { get; set; }
        [JsonPropertyName("downloadAllowed")] public bool DownloadAllowed { get; set; }
        [JsonPropertyName("rejections")] public List<string> Rejections { get; set; } = new();
        [JsonPropertyName("seasonNumber")] public int? SeasonNumber { get; set; }
        [JsonPropertyName("fullSeason")] public bool FullSeason { get; set; }
        [JsonPropertyName("releaseGroup")] public string? ReleaseGroup { get; set; }
        [JsonPropertyName("customFormatScore")] public int CustomFormatScore { get; set; }
        [JsonPropertyName("languages")] public List<string> Languages { get; set; } = new();
        [JsonPropertyName("indexerFlags")] public List<string> IndexerFlags { get; set; } = new();
    }

    /// <summary>The interactive release list for one instance.</summary>
    public sealed class ArrReleaseListDto
    {
        [JsonPropertyName("instanceName")] public string InstanceName { get; set; } = string.Empty;
        [JsonPropertyName("service")] public string Service { get; set; } = string.Empty;
        [JsonPropertyName("releases")] public List<ArrReleaseDto> Releases { get; set; } = new();
        [JsonPropertyName("error")] public string? Error { get; set; }
    }

    /// <summary>Result of an automatic-search dispatch across instances.</summary>
    public sealed class ArrDispatchResultDto
    {
        [JsonPropertyName("dispatched")] public List<ArrDispatchedDto> Dispatched { get; set; } = new();
        [JsonPropertyName("errors")] public List<ArrErrorDto> Errors { get; set; } = new();
    }

    public sealed class ArrDispatchedDto
    {
        [JsonPropertyName("instanceName")] public string InstanceName { get; set; } = string.Empty;
        [JsonPropertyName("commandId")] public int CommandId { get; set; }
        [JsonPropertyName("commandName")] public string CommandName { get; set; } = string.Empty;
    }

    /// <summary>Add-form options for one instance (quality profiles + root folders).</summary>
    public sealed class ArrAddOptionsDto
    {
        [JsonPropertyName("service")] public string Service { get; set; } = string.Empty;
        [JsonPropertyName("instanceName")] public string InstanceName { get; set; } = string.Empty;
        [JsonPropertyName("qualityProfiles")] public List<ArrNamedIdDto> QualityProfiles { get; set; } = new();
        [JsonPropertyName("rootFolders")] public List<ArrRootFolderDto> RootFolders { get; set; } = new();
        /// <summary>Radarr only.</summary>
        [JsonPropertyName("minimumAvailabilityOptions")] public List<string>? MinimumAvailabilityOptions { get; set; }
        [JsonPropertyName("error")] public string? Error { get; set; }
    }

    public sealed class ArrNamedIdDto
    {
        [JsonPropertyName("id")] public int Id { get; set; }
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
    }

    public sealed class ArrRootFolderDto
    {
        [JsonPropertyName("path")] public string Path { get; set; } = string.Empty;
        [JsonPropertyName("freeSpace")] public long FreeSpace { get; set; }
    }

    /// <summary>One active-download row for the post-action progress feedback (mirrors the Downloads page).</summary>
    public sealed class ArrQueueRowDto
    {
        [JsonPropertyName("instanceName")] public string InstanceName { get; set; } = string.Empty;
        [JsonPropertyName("service")] public string Service { get; set; } = string.Empty;
        [JsonPropertyName("title")] public string? Title { get; set; }
        [JsonPropertyName("status")] public string? Status { get; set; }
        [JsonPropertyName("trackedDownloadState")] public string? TrackedDownloadState { get; set; }
        [JsonPropertyName("progress")] public double Progress { get; set; }
        [JsonPropertyName("timeRemaining")] public string? TimeRemaining { get; set; }
    }

    public sealed class ArrErrorDto
    {
        [JsonPropertyName("instanceName")] public string InstanceName { get; set; } = string.Empty;
        [JsonPropertyName("reason")] public string Reason { get; set; } = string.Empty;
    }
}
