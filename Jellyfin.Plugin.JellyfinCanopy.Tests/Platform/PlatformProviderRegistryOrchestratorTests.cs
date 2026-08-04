using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderRegistryOrchestratorTests
{
    private static readonly Guid PluginId = new("11111111-2222-3333-4444-555555555555");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static readonly DateTimeOffset Now = new(2026, 8, 4, 4, 0, 0, TimeSpan.Zero);

    public static IEnumerable<object[]> RepeatedRaceIterations =>
        Enumerable.Range(0, 16).Select(iteration => new object[] { iteration });

    [Fact]
    public void ResultVocabularyAndShapeAreClosedAndBounded()
    {
        Assert.Equal(
            new[]
            {
                "Applied", "Superseded", "Cancelled", "AcquisitionFailed",
                "ReconcileRejected", "Stopped", "EpochExhausted", "NotStarted",
            },
            Enum.GetNames<PlatformProviderRegistryOrchestrationStatus>());

        var result = PlatformProviderRegistryOrchestrationResult.From(
            PlatformProviderRegistryOrchestrationStatus.ReconcileRejected,
            acquisitionCount: 1,
            PlatformProviderRegistryMutationStatus.PersistenceFailed);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.ReconcileRejected, result.Status);
        Assert.Equal(1, result.AcquisitionCount);
        Assert.Equal(PlatformProviderRegistryMutationStatus.PersistenceFailed, result.RegistryStatus);
    }

    [Fact]
    public async Task SuccessfulRunFencesAuthorityBeforeAcquisitionAndRestoresOnlyAfterCommit()
    {
        var registry = ApprovedRegistry(out var observation);
        var enabled = Assert.Single(registry.Snapshot.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        var source = new ScriptedSweepSource(async cancellationToken =>
        {
            Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
            await Task.Yield();
            cancellationToken.ThrowIfCancellationRequested();
            return Completed(observation);
        });
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var result = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, result.Status);
        Assert.Equal(1, result.AcquisitionCount);
        Assert.Equal(PlatformProviderRegistryMutationStatus.Applied, result.RegistryStatus);
        var current = Assert.Single(registry.Snapshot.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, current.Fingerprint!, current.Generation));
    }

    [Fact]
    public async Task ConcurrentTriggerSupersedesActiveAndRunsExactlyOneLatestRequest()
    {
        var registry = Registry(new RecordingStore());
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedSweepSource(
            async cancellationToken =>
            {
                firstEntered.SetResult();
                await releaseFirst.Task.WaitAsync(cancellationToken);
                return Completed();
            },
            _ => ValueTask.FromResult(Completed()));
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var first = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await firstEntered.Task;
        var latest = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        var superseded = await first;
        var completed = await latest;

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Superseded, superseded.Status);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, completed.Status);
        Assert.Equal(1, completed.AcquisitionCount);
        Assert.Equal(2, source.CallCount);
        Assert.Equal(1, source.MaximumConcurrency);
        Assert.Equal(1, registry.Snapshot.Revision);
    }

    [Fact]
    public async Task RepeatedTriggersKeepOnlyLatestPendingRequest()
    {
        var registry = ApprovedRegistry(out var observation);
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var followUpEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFollowUp = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedSweepSource(
            async cancellationToken =>
            {
                firstEntered.SetResult();
                await releaseFirst.Task.WaitAsync(cancellationToken);
                return Completed(observation);
            },
            async cancellationToken =>
            {
                followUpEntered.SetResult();
                await releaseFollowUp.Task.WaitAsync(cancellationToken);
                return Completed(observation);
            },
            _ => ValueTask.FromResult(Completed(observation)));
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var first = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await firstEntered.Task;
        var second = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await followUpEntered.Task;
        var third = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();

        var firstResult = await first;
        var secondResult = await second;
        var thirdResult = await third;
        var enabled = Assert.Single(registry.Snapshot.Entries);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Superseded, firstResult.Status);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Superseded, secondResult.Status);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, thirdResult.Status);
        Assert.Equal(3, source.CallCount);
        Assert.Equal(1, source.MaximumConcurrency);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Fact]
    public async Task CancellationAndAcquisitionFailurePreserveSnapshotWithPostBeginFailureFenced()
    {
        var registry = ApprovedRegistry(out _);
        var before = registry.Snapshot;
        var cancelled = new PlatformProviderRegistryOrchestrator(
            new ScriptedSweepSource(token => throw new OperationCanceledException(token)),
            registry);

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        var cancelledResult = await cancelled.ReconcileAsync(cancellation.Token);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Cancelled, cancelledResult.Status);
        Assert.Equal(0, cancelledResult.AcquisitionCount);
        Assert.Same(before, registry.Snapshot);
        var enabled = Assert.Single(registry.Snapshot.Entries);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        using var duringAcquisition = new CancellationTokenSource();
        var cancelledDuringRun = new PlatformProviderRegistryOrchestrator(
            new ScriptedSweepSource(token =>
            {
                duringAcquisition.Cancel();
                throw new OperationCanceledException(token);
            }),
            registry);
        var cancelledDuringRunResult = await cancelledDuringRun.ReconcileAsync(duringAcquisition.Token);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Cancelled, cancelledDuringRunResult.Status);
        Assert.Equal(1, cancelledDuringRunResult.AcquisitionCount);
        Assert.Same(before, registry.Snapshot);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        var failed = new PlatformProviderRegistryOrchestrator(
            new ScriptedSweepSource(_ => throw new InvalidOperationException("sensitive failure")),
            registry);
        var failedResult = await failed.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.AcquisitionFailed, failedResult.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Null(failedResult.RegistryStatus);
    }

    [Theory]
    [MemberData(nameof(RepeatedRaceIterations))]
    public async Task PersistenceFailureIsClosedWithoutPublishingOrUnfencing(int iteration)
    {
        Assert.InRange(iteration, 0, 15);
        var store = new RecordingStore();
        var registry = ApprovedRegistry(store, out var observation);
        var before = registry.Snapshot;
        var durableBefore = store.State;
        var enabled = Assert.Single(before.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
        store.ThrowOnSave = true;
        var orchestrator = new PlatformProviderRegistryOrchestrator(
            new ScriptedSweepSource(
                _ => ValueTask.FromResult(Completed(observation)),
                _ => ValueTask.FromResult(Completed(observation))),
            registry);

        var result = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.ReconcileRejected, result.Status);
        Assert.Equal(PlatformProviderRegistryMutationStatus.PersistenceFailed, result.RegistryStatus);
        Assert.Same(before, registry.Snapshot);
        Assert.Same(durableBefore, store.State);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        store.ThrowOnSave = false;
        var recovered = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, recovered.Status);
        Assert.NotSame(before, registry.Snapshot);
        Assert.NotSame(durableBefore, store.State);
        var restored = Assert.Single(registry.Snapshot.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, restored.Fingerprint!, restored.Generation));
    }

    [Fact]
    public async Task CancellationRequestedAtSweepCompletionCannotPublish()
    {
        var registry = ApprovedRegistry(out var observation);
        var before = registry.Snapshot;
        var enabled = Assert.Single(before.Entries);
        using var callerCancellation = new CancellationTokenSource();
        var source = new ScriptedSweepSource(_ =>
        {
            callerCancellation.Cancel();
            return ValueTask.FromResult(Completed(observation));
        });
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var result = await orchestrator.ReconcileAsync(callerCancellation.Token);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Cancelled, result.Status);
        Assert.Equal(1, result.AcquisitionCount);
        Assert.Same(before, registry.Snapshot);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Theory]
    [MemberData(nameof(RepeatedRaceIterations))]
    public async Task TriggerBurstDuringNonCooperativeSweepRunsOnlyLatestFollowUp(int iteration)
    {
        Assert.InRange(iteration, 0, 15);
        const int burstCount = 32;
        var registry = ApprovedRegistry(out var observation);
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseFirst = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedSweepSource(
            async _ =>
            {
                firstEntered.SetResult();
                await releaseFirst.Task;
                return Completed();
            },
            _ => ValueTask.FromResult(Completed(observation)));
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var first = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await firstEntered.Task;
        var burst = new Task<PlatformProviderRegistryOrchestrationResult>[burstCount];
        for (var index = 0; index < burst.Length; index++)
        {
            burst[index] = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        }

        releaseFirst.SetResult();
        var firstResult = await first;
        var burstResults = await Task.WhenAll(burst);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Superseded, firstResult.Status);
        Assert.Equal(1, burstResults.Count(value =>
            value.Status == PlatformProviderRegistryOrchestrationStatus.Applied));
        Assert.Equal(burstCount - 1, burstResults.Count(value =>
            value.Status == PlatformProviderRegistryOrchestrationStatus.Superseded));
        Assert.Equal(2, source.CallCount);
        Assert.Equal(1, source.MaximumConcurrency);
        Assert.Equal(3, registry.Snapshot.Revision);
    }

    [Theory]
    [MemberData(nameof(RepeatedRaceIterations))]
    public async Task StopFencesIdleAuthorityAndRejectsNonCooperativeLateCompletion(int iteration)
    {
        Assert.InRange(iteration, 0, 15);
        var registry = ApprovedRegistry(out var observation);
        var firstSource = new ScriptedSweepSource(
            _ => ValueTask.FromResult(Completed(observation)));
        var idleOrchestrator = new PlatformProviderRegistryOrchestrator(firstSource, registry);
        Assert.Equal(
            PlatformProviderRegistryOrchestrationStatus.Applied,
            (await idleOrchestrator.ReconcileAsync(CancellationToken.None)).Status);
        var enabled = Assert.Single(registry.Snapshot.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        await idleOrchestrator.StopAsync(CancellationToken.None);

        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        var before = registry.Snapshot;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var lateSource = new ScriptedSweepSource(async _ =>
        {
            entered.SetResult();
            await release.Task;
            return Completed(observation);
        });
        var lateOrchestrator = new PlatformProviderRegistryOrchestrator(lateSource, registry);
        var attempt = lateOrchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await entered.Task;
        var stop = lateOrchestrator.StopAsync(CancellationToken.None);
        release.SetResult();
        await stop;
        var result = await attempt;

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Stopped, result.Status);
        Assert.Same(before, registry.Snapshot);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Fact]
    public async Task ThrowingCancellationCallbackCannotEscapeOrStrandLatestRequest()
    {
        var registry = Registry(new RecordingStore());
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var never = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedSweepSource(
            async cancellationToken =>
            {
                using var registration = cancellationToken.Register(
                    static () => throw new InvalidOperationException("untrusted cancellation callback"));
                entered.SetResult();
                await never.Task.WaitAsync(cancellationToken);
                return Completed();
            },
            _ => ValueTask.FromResult(Completed()));
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var first = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await entered.Task;
        var latest = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Superseded, (await first).Status);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, (await latest).Status);
        Assert.Equal(2, source.CallCount);
        Assert.Equal(1, source.MaximumConcurrency);
    }

    [Fact]
    public async Task ThrowingLoggerCannotFaultWorkerOrStrandLaterRequest()
    {
        var registry = Registry(new RecordingStore());
        var source = new ScriptedSweepSource(
            _ => ValueTask.FromResult(Completed()),
            _ => ValueTask.FromResult(Completed()));
        var orchestrator = new PlatformProviderRegistryOrchestrator(
            source,
            registry,
            new ThrowingLogger());

        var first = await orchestrator.ReconcileAsync(CancellationToken.None);
        var second = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, first.Status);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, second.Status);
        Assert.Equal(2, registry.Snapshot.Revision);
        Assert.Equal(2, source.CallCount);
        await orchestrator.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task CompletionLogUsesStableBoundedEvidenceAndDropsExceptionText()
    {
        const string sensitive = "/private/provider/root/0a110000-1111-4222-8333-444455556666";
        var registry = Registry(new RecordingStore());
        var logger = new CapturingLogger();
        var orchestrator = new PlatformProviderRegistryOrchestrator(
            new ScriptedSweepSource(_ => throw new InvalidOperationException(sensitive)),
            registry,
            logger);

        var result = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.AcquisitionFailed, result.Status);
        var entry = Assert.Single(logger.Entries);
        Assert.Equal(PlatformProviderRegistryOrchestrator.CompletionEventId, entry.EventId.Id);
        Assert.Equal("PlatformProviderRegistryReconciliationCompleted", entry.EventId.Name);
        Assert.Contains("AcquisitionFailed", entry.Message, StringComparison.Ordinal);
        Assert.Contains("acquisitions=1", entry.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(sensitive, entry.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("/private", entry.Message, StringComparison.Ordinal);
        Assert.Null(entry.Exception);
    }

    [Fact]
    public async Task RepeatedStartupSignalAndStopRaceDoesNotDeadlockOrDetachWorker()
    {
        for (var iteration = 0; iteration < 64; iteration++)
        {
            using var lifetime = new RaceApplicationLifetime();
            var registry = Registry(new RecordingStore());
            var orchestrator = new PlatformProviderRegistryOrchestrator(
                new ScriptedSweepSource(_ => ValueTask.FromResult(Completed())),
                new Lazy<PlatformProviderRegistry>(() => registry),
                lifetime,
                NullLogger<PlatformProviderRegistryOrchestrator>.Instance);
            await orchestrator.StartAsync(CancellationToken.None);

            var signal = Task.Run(lifetime.SignalStarted);
            var stop = Task.Run(() => orchestrator.StopAsync(CancellationToken.None));
            await Task.WhenAll(signal, stop).WaitAsync(TimeSpan.FromSeconds(5));

            var stopped = await orchestrator.ReconcileAsync(CancellationToken.None);
            Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Stopped, stopped.Status);
        }
    }

    [Fact]
    public async Task StopJoinsAlreadySignalledStartupDispatchAndItsNonCooperativeWorker()
    {
        using var lifetime = new RaceApplicationLifetime();
        lifetime.SignalStarted();
        var registry = Registry(new RecordingStore());
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedSweepSource(async _ =>
        {
            entered.TrySetResult();
            await release.Task;
            return Completed();
        });
        var orchestrator = new PlatformProviderRegistryOrchestrator(
            source,
            new Lazy<PlatformProviderRegistry>(() => registry),
            lifetime,
            NullLogger<PlatformProviderRegistryOrchestrator>.Instance);

        await orchestrator.StartAsync(CancellationToken.None);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var stop = orchestrator.StopAsync(CancellationToken.None);

        Assert.False(stop.IsCompleted);
        release.SetResult();
        await stop.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(0, registry.Snapshot.Revision);
        Assert.Equal(
            PlatformProviderRegistryOrchestrationStatus.Stopped,
            (await orchestrator.ReconcileAsync(CancellationToken.None)).Status);
    }

    [Theory]
    [MemberData(nameof(RepeatedRaceIterations))]
    public async Task WholeCommitWinsAtomicallyWhenCancellationArrivesInsideRegistrySave(int iteration)
    {
        Assert.InRange(iteration, 0, 15);
        using var store = new BlockingSaveStore();
        var registry = ApprovedRegistry(store, out var observation);
        var before = registry.Snapshot;
        store.BlockSave = true;
        using var callerCancellation = new CancellationTokenSource();
        var orchestrator = new PlatformProviderRegistryOrchestrator(
            new ScriptedSweepSource(_ => ValueTask.FromResult(Completed(observation))),
            registry);

        var attempt = orchestrator.ReconcileAsync(callerCancellation.Token).AsTask();
        await store.SaveEntered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var cancellation = Task.Run(callerCancellation.Cancel);
        Assert.True(SpinWait.SpinUntil(
            () => callerCancellation.IsCancellationRequested,
            TimeSpan.FromSeconds(5)));

        store.ReleaseSave.Set();
        await cancellation.WaitAsync(TimeSpan.FromSeconds(5));
        var result = await attempt.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, result.Status);
        Assert.Equal(before.Revision + 1, registry.Snapshot.Revision);
        var enabled = Assert.Single(registry.Snapshot.Entries);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Theory]
    [MemberData(nameof(RepeatedRaceIterations))]
    public async Task FailureThenFreshRequestIsTheOnlyAttemptThatRestoresAuthority(int iteration)
    {
        Assert.InRange(iteration, 0, 15);
        var registry = ApprovedRegistry(out var observation);
        var enabled = Assert.Single(registry.Snapshot.Entries);
        var source = new ScriptedSweepSource(
            _ => throw new InvalidOperationException("sensitive acquisition failure"),
            _ => ValueTask.FromResult(Completed(observation)));
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var failed = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.AcquisitionFailed, failed.Status);
        Assert.Null(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));

        var recovered = await orchestrator.ReconcileAsync(CancellationToken.None);

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Applied, recovered.Status);
        Assert.Equal(2, source.CallCount);
        Assert.Equal(1, source.MaximumConcurrency);
        Assert.NotNull(registry.TryRelease(PluginId, enabled.Fingerprint!, enabled.Generation));
    }

    [Fact]
    public async Task StopCancelsAndJoinsCooperativeActiveSweepWithoutPublishing()
    {
        var registry = ApprovedRegistry(out _);
        var before = registry.Snapshot;
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancellationObserved = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var never = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var source = new ScriptedSweepSource(async cancellationToken =>
        {
            entered.SetResult();
            try
            {
                await never.Task.WaitAsync(cancellationToken);
                throw new InvalidOperationException("The blocked acquisition unexpectedly resumed.");
            }
            catch (OperationCanceledException)
            {
                cancellationObserved.SetResult();
                throw;
            }
        });
        var orchestrator = new PlatformProviderRegistryOrchestrator(source, registry);

        var attempt = orchestrator.ReconcileAsync(CancellationToken.None).AsTask();
        await entered.Task;
        var stop = orchestrator.StopAsync(CancellationToken.None);
        await cancellationObserved.Task;
        await stop;
        var result = await attempt;

        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Stopped, result.Status);
        Assert.Equal(1, result.AcquisitionCount);
        Assert.Same(before, registry.Snapshot);
        Assert.Equal(1, source.CallCount);
        Assert.Equal(1, source.MaximumConcurrency);
        var stopped = await orchestrator.ReconcileAsync(CancellationToken.None);
        Assert.Equal(PlatformProviderRegistryOrchestrationStatus.Stopped, stopped.Status);
        Assert.Equal(1, source.CallCount);
    }

    private static PlatformProviderRegistry ApprovedRegistry(
        out PlatformInstalledManifestObservation observation)
    {
        return ApprovedRegistry(new RecordingStore(), out observation);
    }

    private static PlatformProviderRegistry ApprovedRegistry(
        IPlatformProviderRegistryStateStore store,
        out PlatformInstalledManifestObservation observation)
    {
        var registry = Registry(store);
        observation = Acquired();
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(registry.BeginReconciliation(), Completed(observation)).Status);
        var pending = Assert.Single(registry.Snapshot.Entries);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Approve(
                    registry.Snapshot.Revision,
                    PluginId,
                    pending.Generation,
                    pending.Fingerprint!,
                    new[] { "jellyfin.canopy.items.lookup" },
                    "Approved for orchestration test"),
                AdminAuthorization()).Status);
        return registry;
    }

    private static PlatformProviderRegistry Registry(IPlatformProviderRegistryStateStore store) =>
        new(store, new FixedTimeProvider(Now));

    private static PlatformInstalledManifestObservation Acquired()
    {
        var before = PlatformInstalledManifestBindingTests.Snapshot(pluginId: PluginId);
        return PlatformInstalledManifestBinder.Bind(
            before,
            PlatformInstalledManifestBindingTests.Snapshot(pluginId: PluginId),
            PlatformInstalledManifestReadResult.Acquired(
                PlatformInstalledManifestBindingTests.ManifestBytes(
                    pluginId: PluginId.ToString("D"),
                    capabilities: new[] { "jellyfin.canopy.items.lookup" }),
                "Example.Provider"));
    }

    private static PlatformInstalledManifestSweep Completed(
        params PlatformInstalledManifestObservation[] observations) =>
        PlatformInstalledManifestSweep.EstablishCompleted(observations.ToImmutableArray());

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var actor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "registry-orchestration-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                actor,
                new ReauthorizationHost()));
    }

    private sealed class ScriptedSweepSource : IPlatformInstalledManifestSweepSource
    {
        private readonly Queue<Func<CancellationToken, ValueTask<PlatformInstalledManifestSweep>>> _steps;
        private int _concurrency;

        internal ScriptedSweepSource(
            params Func<CancellationToken, ValueTask<PlatformInstalledManifestSweep>>[] steps) =>
            _steps = new Queue<Func<CancellationToken, ValueTask<PlatformInstalledManifestSweep>>>(steps);

        internal int CallCount { get; private set; }

        internal int MaximumConcurrency { get; private set; }

        public async ValueTask<PlatformInstalledManifestSweep> SweepAsync(
            CancellationToken cancellationToken)
        {
            CallCount++;
            var active = Interlocked.Increment(ref _concurrency);
            MaximumConcurrency = Math.Max(MaximumConcurrency, active);
            try
            {
                return await _steps.Dequeue()(cancellationToken);
            }
            finally
            {
                Interlocked.Decrement(ref _concurrency);
            }
        }
    }

    private sealed class RecordingStore : IPlatformProviderRegistryStateStore
    {
        private PlatformProviderRegistryDurableState _state = PlatformProviderRegistryDurableState.Empty;

        internal bool ThrowOnSave { get; set; }

        internal PlatformProviderRegistryDurableState State => _state;

        public PlatformProviderRegistryStoreLoadResult Load() =>
            PlatformProviderRegistryStoreLoadResult.Healthy(_state);

        public void Save(PlatformProviderRegistryDurableState state)
        {
            if (ThrowOnSave)
            {
                throw new InvalidOperationException("Injected persistence failure.");
            }

            _state = state;
        }

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc) =>
            _state = PlatformProviderRegistryDurableState.Empty;

        public void FenceQuarantined()
        {
        }
    }

    private sealed class BlockingSaveStore : IPlatformProviderRegistryStateStore, IDisposable
    {
        private PlatformProviderRegistryDurableState _state = PlatformProviderRegistryDurableState.Empty;

        internal bool BlockSave { get; set; }

        internal TaskCompletionSource SaveEntered { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        internal ManualResetEventSlim ReleaseSave { get; } = new(initialState: false);

        public PlatformProviderRegistryStoreLoadResult Load() =>
            PlatformProviderRegistryStoreLoadResult.Healthy(_state);

        public void Save(PlatformProviderRegistryDurableState state)
        {
            if (BlockSave)
            {
                SaveEntered.TrySetResult();
                ReleaseSave.Wait();
            }

            _state = state;
        }

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc) =>
            _state = PlatformProviderRegistryDurableState.Empty;

        public void FenceQuarantined()
        {
        }

        public void Dispose()
        {
            ReleaseSave.Set();
            ReleaseSave.Dispose();
        }
    }

    private sealed class FixedTimeProvider : TimeProvider
    {
        private readonly DateTimeOffset _now;

        internal FixedTimeProvider(DateTimeOffset now) => _now = now;

        public override DateTimeOffset GetUtcNow() => _now;
    }

    private sealed class ThrowingLogger : ILogger<PlatformProviderRegistryOrchestrator>
    {
        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            throw new InvalidOperationException("logging infrastructure failure");
    }

    private sealed class CapturingLogger : ILogger<PlatformProviderRegistryOrchestrator>
    {
        internal List<LogEntry> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter) =>
            Entries.Add(new LogEntry(eventId, formatter(state, exception), exception));
    }

    private sealed record LogEntry(EventId EventId, string Message, Exception? Exception);

    private sealed class RaceApplicationLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource _started = new();
        private readonly CancellationTokenSource _stopping = new();
        private readonly CancellationTokenSource _stopped = new();

        public CancellationToken ApplicationStarted => _started.Token;

        public CancellationToken ApplicationStopping => _stopping.Token;

        public CancellationToken ApplicationStopped => _stopped.Token;

        public void StopApplication() => _stopping.Cancel();

        internal void SignalStarted() => _started.Cancel();

        public void Dispose()
        {
            _started.Dispose();
            _stopping.Dispose();
            _stopped.Dispose();
        }
    }

    private sealed class ReauthorizationHost : IPlatformHost, IHostUsers
    {
        public IHostUsers Users => this;

        public IHostLibrary Library => throw new NotSupportedException();

        public IHostSessions Sessions => throw new NotSupportedException();

        public IHostPlugins Plugins => throw new NotSupportedException();

        public HostUser? Find(Guid id) => id == AdminId
            ? new HostUser(AdminId, "Registry admin", true)
            : null;

        public IReadOnlyList<HostUser> All() => [];
    }
}
