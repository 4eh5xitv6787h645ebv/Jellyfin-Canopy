using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using Jellyfin.Plugin.JellyfinCanopy.Services.Arr;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services;

public sealed class ArrDownloadLifecycleTests
{
    [Theory]
    [InlineData("completed", "importPending", "ok", "importPending", "processing")]
    [InlineData("completed", "", "ok", "waitingForImport", "processing")]
    [InlineData("downloading", "importing", "ok", "importing", "processing")]
    [InlineData("paused", "importPending", "ok", "importPending", "processing")]
    [InlineData("delay", "imported", "ok", "imported", "history")]
    [InlineData("paused", "downloading", "ok", "paused", "downloading")]
    [InlineData("delay", "downloading", "ok", "delayed", "downloading")]
    [InlineData("completed", "importBlocked", "warning", "attention", "processing")]
    [InlineData("downloading", "failedPending", "error", "attention", "processing")]
    [InlineData("warning", "downloading", "warning", "warning", "processing")]
    [InlineData("failed", "failed", "error", "failed", "processing")]
    [InlineData("completed", "ignored", "ok", "canceled", "history")]
    [InlineData("completed", "imported", "ok", "imported", "history")]
    [InlineData("futureState", "futureTracked", "ok", "unknown", "processing")]
    public void NormalizeQueue_UsesDeterministicNonSuccessPrecedence(
        string status,
        string trackedState,
        string trackedStatus,
        string expectedLifecycle,
        string expectedSection)
    {
        var actual = ArrDownloadLifecycleNormalizer.NormalizeQueue(new ArrDownloadQueueSignal
        {
            RawStatus = status,
            TrackedState = trackedState,
            TrackedStatus = trackedStatus,
            Size = 100,
            SizeLeft = 0,
        });

        Assert.Equal(expectedLifecycle, actual.Lifecycle);
        Assert.Equal(expectedSection, actual.Section);
    }

    [Fact]
    public void NormalizeQueue_OneHundredPercentNeverCreatesSuccess()
    {
        var actual = ArrDownloadLifecycleNormalizer.NormalizeQueue(new ArrDownloadQueueSignal
        {
            RawStatus = "completed",
            TrackedState = "importPending",
            TrackedStatus = "warning",
            Size = 100,
            SizeLeft = 0,
        });

        Assert.Equal(100, ArrDownloadLifecycleNormalizer.CalculateTransferProgress(100, 0));
        Assert.Equal(ArrDownloadLifecycles.Warning, actual.Lifecycle);
        Assert.False(actual.Terminal);
    }

    [Fact]
    public void CalculateTransferProgress_UnknownInputsRemainUnknown()
    {
        Assert.Null(ArrDownloadLifecycleNormalizer.CalculateTransferProgress(null, 0));
        Assert.Null(ArrDownloadLifecycleNormalizer.CalculateTransferProgress(100, null));
        Assert.Null(ArrDownloadLifecycleNormalizer.CalculateTransferProgress(0, 0));
        Assert.Null(ArrDownloadLifecycleNormalizer.CalculateTransferProgress(double.NaN, 0));
    }

    [Theory]
    [InlineData(100, -10, 100)]
    [InlineData(100, 200, 0)]
    [InlineData(100, 25, 75)]
    public void CalculateTransferProgress_ClampsFiniteInputs(
        double size,
        double left,
        double expected)
        => Assert.Equal(
            expected,
            ArrDownloadLifecycleNormalizer.CalculateTransferProgress(size, left));

    [Fact]
    public void Reconcile_ImportedHistoryReplacesOverlappingActiveQueue()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var queue = Authorized(Queue("q1", "job", "episode:10", at, "importing"));
        var history = new[]
        {
            Authorized(History("h1", "job", "episode:10", at.AddMinutes(-5), "grabbed")),
            Authorized(History("h2", "job", "episode:10", at.AddMinutes(1), "downloadFolderImported")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(new[] { queue }, history);

        Assert.Empty(result.Active);
        var imported = Assert.Single(result.History);
        Assert.Equal(ArrDownloadLifecycles.Imported, imported.Lifecycle);
        Assert.True(imported.Terminal);
    }

    [Fact]
    public void Reconcile_MissingQueueTimestampDoesNotFabricateAttemptOverlap()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var queue = Authorized(Queue(
            "q1",
            "reused-job",
            "episode:10",
            at,
            "importing") with { OccurredAt = null });
        var history = new[]
        {
            Authorized(History(
                "h1",
                "reused-job",
                "episode:10",
                at.AddMinutes(-5),
                "grabbed")),
            Authorized(History(
                "h2",
                "reused-job",
                "episode:10",
                at.AddMinutes(-1),
                "downloadFolderImported")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(new[] { queue }, history);

        Assert.Single(result.Active);
        Assert.Single(result.History);
        Assert.NotEqual(result.Active[0].Id, result.History[0].Id);
    }

    [Fact]
    public void Reconcile_PartialSeasonPackIsAttentionNotImported()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History("h1", "pack", "episode:1", at, "grabbed")),
            Authorized(History("h2", "pack", "episode:2", at, "grabbed")),
            Authorized(History("h3", "pack", "episode:1", at.AddMinutes(2), "downloadFolderImported")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            Array.Empty<ArrAuthorizedRecord>(),
            history);

        Assert.Empty(result.History);
        var partial = Assert.Single(result.Active);
        Assert.Equal(ArrDownloadLifecycles.Attention, partial.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.PartialImport, partial.ReasonCode);
        Assert.Equal(1, partial.ImportedCount);
        Assert.Equal(2, partial.ExpectedCount);
        Assert.True(partial.Partial);
        Assert.False(partial.Terminal);
    }

    [Fact]
    public void Reconcile_RegrabWithReusedDownloadIdPreservesBothAttempts()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History("h1", "reused", "episode:1", at, "grabbed")),
            Authorized(History("h2", "reused", "episode:1", at.AddMinutes(1), "downloadFolderImported")),
            Authorized(History("h3", "reused", "episode:1", at.AddHours(1), "grabbed")),
            Authorized(History("h4", "reused", "episode:1", at.AddHours(1).AddMinutes(1), "downloadFailed")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            Array.Empty<ArrAuthorizedRecord>(),
            history);

        Assert.Equal(2, result.History.Count);
        Assert.Equal(
            new[] { ArrDownloadLifecycles.Imported, ArrDownloadLifecycles.Failed },
            result.History.Select(item => item.Lifecycle).ToArray());
        Assert.Equal(2, result.History.Select(item => item.Id).Distinct().Count());
    }

    [Theory]
    [InlineData("downloadFailed")]
    [InlineData("downloadIgnored")]
    public void Reconcile_LaterSuccessfulImportSupersedesEarlierTerminalProblem(
        string earlierEvent)
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History("h1", "job", "episode:1", at, "grabbed")),
            Authorized(History("h2", "job", "episode:1", at.AddMinutes(1), earlierEvent)),
            Authorized(History(
                "h3",
                "job",
                "episode:1",
                at.AddMinutes(2),
                "downloadFolderImported")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            Array.Empty<ArrAuthorizedRecord>(),
            history);

        var imported = Assert.Single(result.History);
        Assert.Equal(ArrDownloadLifecycles.Imported, imported.Lifecycle);
        Assert.True(imported.Terminal);
    }

    [Fact]
    public void Reconcile_LaterFailureSupersedesEarlierSuccessfulImport()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History("h1", "job", "episode:1", at, "grabbed")),
            Authorized(History(
                "h2",
                "job",
                "episode:1",
                at.AddMinutes(1),
                "downloadFolderImported")),
            Authorized(History("h3", "job", "episode:1", at.AddMinutes(2), "downloadFailed")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            Array.Empty<ArrAuthorizedRecord>(),
            history);

        var failed = Assert.Single(result.History);
        Assert.Equal(ArrDownloadLifecycles.Failed, failed.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.DownloadFailed, failed.ReasonCode);
        Assert.True(failed.Terminal);
    }

    [Fact]
    public void Reconcile_LaterGrabMarkerKeepsActiveRegrabWithinHandoffTolerance()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History("h1", "reused", "episode:1", at.AddMinutes(-2), "grabbed")),
            Authorized(History("h2", "reused", "episode:1", at, "downloadFolderImported")),
            Authorized(History("h3", "reused", "episode:1", at.AddMinutes(1), "grabbed")),
        };
        var queue = Authorized(Queue(
            "q1",
            "reused",
            "episode:1",
            at.AddMinutes(2),
            "downloading") with
        {
            RawStatus = "downloading",
            SizeLeft = 25,
        });

        var result = ArrDownloadActivityReconciler.Reconcile(new[] { queue }, history);

        var active = Assert.Single(result.Active);
        var imported = Assert.Single(result.History);
        Assert.Equal(ArrDownloadLifecycles.Downloading, active.Lifecycle);
        Assert.Equal(ArrDownloadLifecycles.Imported, imported.Lifecycle);
        Assert.NotEqual(active.Id, imported.Id);
    }

    [Theory]
    [InlineData("downloadFolderImported", ArrDownloadLifecycles.Imported, 0)]
    [InlineData("downloadFolderImported", ArrDownloadLifecycles.Imported, 60)]
    [InlineData("downloadFailed", ArrDownloadLifecycles.Failed, 0)]
    [InlineData("downloadFailed", ArrDownloadLifecycles.Failed, 60)]
    public void Reconcile_ImmediateRetryWithoutGrabMarkerIsNotHiddenByTerminalAtOrBeforeStart(
        string terminalEvent,
        string expectedTerminalLifecycle,
        int queueOffsetSeconds)
    {
        var terminalAt = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History(
                "h1",
                "reused",
                "episode:1",
                terminalAt.AddMinutes(-2),
                "grabbed")),
            Authorized(History(
                "h2",
                "reused",
                "episode:1",
                terminalAt,
                terminalEvent)),
        };
        var queue = Authorized(Queue(
            "q1",
            "reused",
            "episode:1",
            terminalAt.AddSeconds(queueOffsetSeconds),
            "downloading") with
        {
            RawStatus = "downloading",
            SizeLeft = 25,
        });

        var result = ArrDownloadActivityReconciler.Reconcile(new[] { queue }, history);

        var active = Assert.Single(result.Active);
        Assert.Equal(ArrDownloadLifecycles.Downloading, active.Lifecycle);
        var terminal = Assert.Single(result.History);
        Assert.Equal(expectedTerminalLifecycle, terminal.Lifecycle);
        Assert.NotEqual(active.Id, terminal.Id);
    }

    [Fact]
    public void Reconcile_StrongKeyJoinWorkRemainsLinearAtLargeScale()
    {
        const int activityCount = 4_096;
        var startedAt = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var queue = Enumerable.Range(1, activityCount)
            .Select(index => Authorized(Queue(
                $"q-{index}",
                $"job-{index}",
                $"episode:{index}",
                startedAt,
                "importing")))
            .ToArray();
        var history = Enumerable.Range(1, activityCount)
            .Select(index => Authorized(History(
                $"h-{index}",
                $"job-{index}",
                $"episode:{index}",
                startedAt.AddMinutes(1),
                "downloadFolderImported")))
            .ToArray();

        var result = ArrDownloadActivityReconciler.Reconcile(queue, history);

        Assert.Empty(result.Active);
        Assert.Equal(activityCount, result.History.Count);
        // These operation counters are a deterministic complexity guard. A nested scan would
        // require activityCount² candidate checks instead of one index write and lookup per key.
        Assert.Equal(activityCount, result.HistoryAttemptIndexWrites);
        Assert.Equal(activityCount, result.QueueAttemptIndexLookups);
        Assert.Equal(
            activityCount * 2,
            result.HistoryAttemptIndexWrites + result.QueueAttemptIndexLookups);
    }

    [Fact]
    public void Reconcile_MissingDownloadIdImportEventsRemainIndependent()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var history = new[]
        {
            Authorized(History("h1", null, "episode:1", at, "downloadFolderImported")),
            Authorized(History("h2", null, "episode:2", at.AddMinutes(1), "downloadFolderImported")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            Array.Empty<ArrAuthorizedRecord>(),
            history);

        Assert.Equal(2, result.History.Count);
        Assert.Equal(2, result.History.Select(item => item.Id).Distinct().Count());
    }

    [Fact]
    public void Reconcile_MissingParentEntityNeverJoinsSharedDownloadIds()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var first = Queue("q1", "shared", "queue:q1", at, "downloading") with
        {
            ParentEntityKey = string.Empty,
        };
        var second = Queue("q2", "shared", "queue:q2", at, "downloading") with
        {
            ParentEntityKey = string.Empty,
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            new[] { Authorized(first), Authorized(second) },
            Array.Empty<ArrAuthorizedRecord>());

        Assert.Equal(2, result.Active.Count);
        Assert.Equal(2, result.Active.Select(item => item.Id).Distinct().Count());
    }

    [Fact]
    public void Reconcile_OverlappingNumericIdsAcrossInstancesNeverCollide()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var first = Authorized(History(
            "1",
            null,
            "movie:1",
            at,
            "downloadFolderImported",
            instanceId: new string('a', 32)));
        var second = Authorized(History(
            "1",
            null,
            "movie:1",
            at,
            "downloadFolderImported",
            instanceId: new string('b', 32)));

        var result = ArrDownloadActivityReconciler.Reconcile(
            Array.Empty<ArrAuthorizedRecord>(),
            new[] { first, second });

        Assert.Equal(2, result.History.Select(item => item.Id).Distinct().Count());
        Assert.Equal(2, result.History.Select(item => item.InstanceId).Distinct().Count());
    }

    [Fact]
    public void Reconcile_GroupAvailabilityRequiresEveryMemberToBeVerified()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var firstId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        var secondId = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
        var queue = new[]
        {
            Authorized(
                Queue("q1", "pack", "episode:1", at, "downloading"),
                firstId,
                available: true),
            Authorized(
                Queue("q2", "pack", "episode:2", at, "downloading"),
                secondId,
                available: false),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            queue,
            Array.Empty<ArrAuthorizedRecord>());

        var activity = Assert.Single(result.Active);
        Assert.Equal(ArrDownloadAvailability.Unavailable, activity.Availability);
        Assert.Null(activity.JellyfinItemId);
    }

    [Fact]
    public void Reconcile_GroupNavigationRequiresEveryMemberToBeAccessible()
    {
        var at = DateTimeOffset.Parse("2026-07-25T10:00:00Z");
        var accessibleId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
        var queue = new[]
        {
            Authorized(
                Queue("q1", "pack", "episode:1", at, "downloading"),
                accessibleId,
                available: true),
            Authorized(Queue("q2", "pack", "episode:2", at, "downloading")),
        };

        var result = ArrDownloadActivityReconciler.Reconcile(
            queue,
            Array.Empty<ArrAuthorizedRecord>());

        var activity = Assert.Single(result.Active);
        Assert.Equal(ArrDownloadAvailability.Unknown, activity.Availability);
        Assert.Null(activity.JellyfinItemId);
    }

    [Fact]
    public void WireDtoSerializationContainsOnlySanitizedContractFields()
    {
        var json = JsonSerializer.Serialize(new ArrDownloadActivityDto
        {
            Id = "activity-safe",
            Source = "Sonarr",
            InstanceId = new string('a', 32),
            InstanceName = "Television",
            Title = "Example",
            Lifecycle = ArrDownloadLifecycles.ImportPending,
            Section = ArrDownloadSections.Processing,
        });

        Assert.DoesNotContain("downloadId", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("apiKey", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("outputPath", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("statusMessages", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sourceTitle", json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("posterUrl", json, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void VisibilityPolicy_IsServerEnforcedForEveryRegularUserSection()
    {
        var denied = new ArrDownloadAccessContext
        {
            AllowActive = false,
            AllowProcessing = false,
            AllowHistory = false,
        };

        Assert.Null(ArrDownloadActivityService.ApplyVisibility(
            Activity(ArrDownloadSections.Downloading, ArrDownloadLifecycles.Downloading),
            denied));
        Assert.Null(ArrDownloadActivityService.ApplyVisibility(
            Activity(ArrDownloadSections.Processing, ArrDownloadLifecycles.Importing),
            denied));
        Assert.Null(ArrDownloadActivityService.ApplyVisibility(
            Activity(ArrDownloadSections.History, ArrDownloadLifecycles.Imported),
            denied));
    }

    [Fact]
    public void VisibilityPolicy_HidesWarningsDetailsAndProvenanceWithoutLyingAboutSuccess()
    {
        var input = Activity(ArrDownloadSections.Processing, ArrDownloadLifecycles.Attention);
        input.ReasonCode = ArrDownloadReasonCodes.ImportBlocked;
        input.Provenance = ArrDownloadProvenance.SeerrAssociated;
        var projected = ArrDownloadActivityService.ApplyVisibility(
            input,
            new ArrDownloadAccessContext
            {
                AllowProcessing = true,
                AllowWarnings = false,
                AllowProvenance = false,
                DetailedLifecycle = false,
            });

        Assert.NotNull(projected);
        Assert.Equal(ArrDownloadLifecycles.WaitingForImport, projected.Lifecycle);
        Assert.Null(projected.ReasonCode);
        Assert.Null(projected.Provenance);
        Assert.NotEqual(ArrDownloadLifecycles.Imported, projected.Lifecycle);
    }

    [Fact]
    public void VisibilityPolicy_SimplifiedFailureRemainsActionableWhenWarningsAreAllowed()
    {
        var input = Activity(ArrDownloadSections.Processing, ArrDownloadLifecycles.Failed);
        input.ReasonCode = ArrDownloadReasonCodes.DownloadFailed;

        var projected = ArrDownloadActivityService.ApplyVisibility(
            input,
            new ArrDownloadAccessContext
            {
                AllowProcessing = true,
                AllowWarnings = true,
                DetailedLifecycle = false,
            });

        Assert.NotNull(projected);
        Assert.Equal(ArrDownloadLifecycles.Attention, projected.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.DownloadFailed, projected.ReasonCode);
    }

    [Fact]
    public void VisibilityPolicy_AdminRetainsSanitizedDetail()
    {
        var input = Activity(ArrDownloadSections.Processing, ArrDownloadLifecycles.Warning);
        input.ReasonCode = ArrDownloadReasonCodes.DownloadWarning;
        input.Provenance = ArrDownloadProvenance.Unknown;

        var projected = ArrDownloadActivityService.ApplyVisibility(
            input,
            new ArrDownloadAccessContext { IsAdmin = true });

        Assert.NotNull(projected);
        Assert.Same(input, projected);
        Assert.Equal(ArrDownloadLifecycles.Warning, projected.Lifecycle);
        Assert.Equal(ArrDownloadReasonCodes.DownloadWarning, projected.ReasonCode);
        Assert.Equal(ArrDownloadProvenance.Unknown, projected.Provenance);
    }

    [Theory]
    [InlineData(55, "movie", 0, true)]
    [InlineData(55, "tv", 0, true)]
    [InlineData(0, "tv", 77, true)]
    [InlineData(56, "movie", 0, false)]
    [InlineData(0, "tv", 0, false)]
    public void Provenance_RequiresPositiveCompleteSeerrAssociation(
        int tmdbId,
        string mediaType,
        int tvdbId,
        bool expected)
    {
        var record = Record("1", "job", "movie:1", DateTimeOffset.UtcNow) with
        {
            MediaType = mediaType,
            TmdbId = tmdbId == 0 ? null : tmdbId,
            TvdbId = tvdbId == 0 ? null : tvdbId,
        };
        var context = new ArrDownloadAccessContext
        {
            SeerrScopeComplete = true,
            SeerrRequests = new HashSet<(int, string)>
            {
                (55, "movie"),
                (55, "tv"),
            },
            SeerrTvTvdbIds = new HashSet<int> { 77 },
            SeerrArrScopes = new HashSet<(string, string)>
            {
                ("Sonarr", new string('a', 32)),
            },
        };

        Assert.Equal(expected, ArrDownloadActivityService.IsSeerrAssociated(record, context));
        Assert.False(ArrDownloadActivityService.IsSeerrAssociated(
            record,
            new ArrDownloadAccessContext
            {
                SeerrScopeComplete = false,
                SeerrRequests = context.SeerrRequests,
                SeerrTvTvdbIds = context.SeerrTvTvdbIds,
                SeerrArrScopes = context.SeerrArrScopes,
            }));
    }

    [Fact]
    public void Provenance_RequiresAnUnambiguousRecordInstanceScope()
    {
        var record = Record("1", "job", "movie:1", DateTimeOffset.UtcNow) with
        {
            MediaType = "movie",
            TmdbId = 55,
        };
        var context = new ArrDownloadAccessContext
        {
            SeerrScopeComplete = true,
            SeerrRequests = new HashSet<(int, string)> { (55, "movie") },
            SeerrArrScopes = new HashSet<(string, string)>
            {
                ("Sonarr", new string('b', 32)),
            },
        };

        Assert.False(ArrDownloadActivityService.IsSeerrAssociated(record, context));
    }

    [Fact]
    public void ProvenanceTopology_FailsClosedForMultipleSourcesOrSameServiceInstances()
    {
        var config = new PluginConfiguration
        {
            SonarrInstances =
                """[{"InstanceId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Name":"TV","Url":"http://localhost:8989","ApiKey":"one","Enabled":true}]""",
            RadarrInstances =
                """[{"InstanceId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","Name":"Movies A","Url":"http://localhost:7878","ApiKey":"two","Enabled":true},{"InstanceId":"cccccccccccccccccccccccccccccccc","Name":"Movies B","Url":"http://localhost:7879","ApiKey":"three","Enabled":true}]""",
        };

        Assert.Empty(
            ArrDownloadActivityService.GetUnambiguousSeerrArrScopes(config, 2));

        var singleSourceScopes =
            ArrDownloadActivityService.GetUnambiguousSeerrArrScopes(config, 1);
        Assert.Contains(("Sonarr", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), singleSourceScopes);
        Assert.DoesNotContain(
            singleSourceScopes,
            scope => string.Equals(scope.Source, "Radarr", StringComparison.Ordinal));
    }

    private static ArrAuthorizedRecord Authorized(
        ArrDownloadActivityRecord record,
        Guid? jellyfinItemId = null,
        bool available = false)
        => new()
        {
            Record = record,
            SeerrAssociated = false,
            JellyfinItemId = jellyfinItemId,
            JellyfinAvailable = available,
        };

    private static ArrDownloadActivityRecord Queue(
        string recordId,
        string? downloadId,
        string entity,
        DateTimeOffset occurredAt,
        string trackedState)
        => Record(recordId, downloadId, entity, occurredAt) with
        {
            RawStatus = "completed",
            TrackedState = trackedState,
            TrackedStatus = "ok",
            Size = 100,
            SizeLeft = 0,
        };

    private static ArrDownloadActivityRecord History(
        string recordId,
        string? downloadId,
        string entity,
        DateTimeOffset occurredAt,
        string eventType,
        string? instanceId = null)
        => Record(recordId, downloadId, entity, occurredAt, instanceId) with
        {
            HistoryEventType = eventType,
        };

    private static ArrDownloadActivityRecord Record(
        string recordId,
        string? downloadId,
        string entity,
        DateTimeOffset occurredAt,
        string? instanceId = null)
    {
        var stableId = instanceId ?? new string('a', 32);
        return new ArrDownloadActivityRecord
        {
            Source = "Sonarr",
            Instance = new ArrInstance
            {
                InstanceId = stableId,
                Name = "Television",
            },
            InstanceId = stableId,
            InstanceName = "Television",
            RecordId = recordId,
            DownloadId = downloadId,
            ParentEntityKey = "series:1",
            EntityKey = entity,
            MediaType = "tv",
            Title = "Example",
            OccurredAt = occurredAt,
        };
    }

    private static ArrDownloadActivityDto Activity(string section, string lifecycle)
        => new()
        {
            Id = "activity-test",
            Source = "Sonarr",
            InstanceId = new string('a', 32),
            InstanceName = "Television",
            Title = "Example",
            MediaType = "tv",
            Section = section,
            Lifecycle = lifecycle,
        };
}
