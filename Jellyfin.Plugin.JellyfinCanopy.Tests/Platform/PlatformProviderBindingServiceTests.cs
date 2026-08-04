using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform;

public sealed class PlatformProviderBindingServiceTests
{
    private const string OperationId = "org.jellyfin.canopy.conformance.hello";
    private const string ItemLookup = "jellyfin.canopy.items.lookup";
    private const string StorageRead = "jellyfin.canopy.storage.read";
    private static readonly Guid PluginId = new("0a110000-1111-4222-8333-444455556666");
    private static readonly Guid AdminId = new("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    private static readonly DateTimeOffset Now = new(2026, 8, 4, 10, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ExactAlphaFixtureBindsAtomicallyWithoutInvokingItsOperation()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var services = new ServiceCollection();
        services.AddSingleton(foreign.Binding.EntrypointType, foreign.Binding.Instance);
        using var serviceProvider = services.BuildServiceProvider();
        var plugin = new LocalPlugin(
            "/plugins/alpha",
            true,
            new PluginManifest
            {
                Id = PluginId,
                Name = "mutable display name",
                Version = "1.0.0.0",
                Status = PluginStatus.Active,
            })
        {
            Instance = foreign.PluginInstance,
        };
        var host = new JellyfinPlatformProviderBindingHost(
            () => new[] { plugin },
            serviceProvider.GetService);
        var service = Service(registry, host);

        var result = service.Bind(PluginId, OperationId, negotiatedProtocol: 1);

        Assert.Equal(PlatformProviderBindingStatus.Bound, result.Status);
        var binding = Assert.IsType<PlatformProviderBoundOperation>(result.Binding);
        Assert.Same(foreign.Binding.Assembly, binding.Entrypoint.Assembly);
        Assert.Same(foreign.Binding.EntrypointType, binding.Entrypoint.EntrypointType);
        Assert.Same(foreign.Binding.Instance, binding.Entrypoint.Instance);
        Assert.Same(foreign.Binding.InvocationMethod, binding.Entrypoint.InvocationMethod);
        Assert.Equal(PluginId, binding.Claim.PluginId);
        Assert.Equal(1, binding.Claim.NegotiatedProtocol);
        Assert.Equal(
            binding.Claim.Operation.RequestSchemaId,
            binding.Schemas.RequestSchema.GetProperty("$id").GetString());
        Assert.Equal(
            binding.Claim.Operation.ResponseSchemaId,
            binding.Schemas.ResponseSchema.GetProperty("$id").GetString());
        Assert.Same(
            foreign.Binding.Instance,
            serviceProvider.GetService(foreign.Binding.EntrypointType));
    }

    [Fact]
    public async Task ExactAlphaFixtureInvokesThroughProductionValidationAndProtectedRelease()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var services = new ServiceCollection();
        services.AddSingleton(foreign.Binding.EntrypointType, foreign.Binding.Instance);
        using var serviceProvider = services.BuildServiceProvider();
        var plugin = new LocalPlugin(
            "/plugins/alpha",
            true,
            new PluginManifest
            {
                Id = PluginId,
                Name = "Alpha",
                Version = "1.0.0.0",
                Status = PluginStatus.Active,
            })
        {
            Instance = foreign.PluginInstance,
        };
        var host = new JellyfinPlatformProviderBindingHost(
            () => new[] { plugin },
            serviceProvider.GetService);
        var bound = Assert.IsType<PlatformProviderBoundOperation>(
            Service(registry, host).Bind(PluginId, OperationId, 1).Binding);
        using var input = JsonDocument.Parse("{\"name\":\"Canopy\"}");
        var request = new PlatformProviderInvocationRequest(
            "alpha-call-1",
            "user-1",
            "device-1",
            itemId: null,
            surface: "item-detail",
            locale: "en-AU",
            accessibilityHints: ImmutableArray<string>.Empty,
            remainingDeadlineMilliseconds: 30_000,
            input.RootElement);
        var invocation = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            host,
            TimeProvider.System);

        var result = await invocation.InvokeAsync(bound, request, CancellationToken.None);

        Assert.Equal(PlatformProviderInvocationStatus.Succeeded, result.Status);
        Assert.Equal("Hello, Canopy!", result.Result!.Value.GetProperty("message").GetString());
    }

    [Fact]
    public async Task OperationSchemaRejectionAndStaleAuthorityNeverInvokeAlpha()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var plugin = new LocalPlugin(
            "/plugins/alpha",
            true,
            new PluginManifest
            {
                Id = PluginId,
                Name = "Alpha",
                Version = "1.0.0.0",
                Status = PluginStatus.Active,
            })
        {
            Instance = foreign.PluginInstance,
        };
        var host = new JellyfinPlatformProviderBindingHost(
            () => new[] { plugin },
            type => type == foreign.Binding.EntrypointType ? foreign.Binding.Instance : null);
        var bound = Assert.IsType<PlatformProviderBoundOperation>(
            Service(registry, host).Bind(PluginId, OperationId, 1).Binding);
        var invocation = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            host,
            TimeProvider.System);
        using var invalidInput = JsonDocument.Parse("{\"name\":\"\"}");
        var invalid = Request(invalidInput.RootElement);

        var rejected = await invocation.InvokeAsync(bound, invalid, CancellationToken.None);
        _ = registry.BeginReconciliation();
        using var validInput = JsonDocument.Parse("{\"name\":\"Canopy\"}");
        var stale = await invocation.InvokeAsync(
            bound,
            Request(validInput.RootElement),
            CancellationToken.None);

        Assert.Equal(PlatformProviderInvocationStatus.RequestSchemaRejected, rejected.Status);
        Assert.Equal(PlatformProviderInvocationStatus.AuthorityChanged, stale.Status);
        Assert.Null(rejected.Result);
        Assert.Null(stale.Result);

        static PlatformProviderInvocationRequest Request(JsonElement input) => new(
            "alpha-call-2",
            "user-1",
            "device-1",
            itemId: null,
            surface: null,
            locale: "en-AU",
            accessibilityHints: ImmutableArray<string>.Empty,
            remainingDeadlineMilliseconds: 30_000,
            input);
    }

    [Fact]
    public async Task SynchronousAndAsynchronousProviderFaultsAreIdenticallyRedacted()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var entrypoint = new ControlledEntrypoint
        {
            Handler = (_, _, _) => throw new InvalidOperationException("synchronous provider secret"),
        };
        var host = new RecordingHost(_ => throw new InvalidOperationException("must not bind"));
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            host,
            TimeProvider.System);
        var bound = TestBound(registry, entrypoint);

        var synchronous = await service.InvokeAsync(
            bound,
            InvocationRequest(),
            CancellationToken.None);
        entrypoint.Handler = (_, _, _) =>
            Task.FromException<string>(new InvalidOperationException("asynchronous provider secret"));
        var asynchronous = await service.InvokeAsync(
            bound,
            InvocationRequest(),
            CancellationToken.None);

        Assert.Equal(PlatformProviderInvocationStatus.ProviderFaulted, synchronous.Status);
        Assert.Equal(PlatformProviderInvocationStatus.ProviderFaulted, asynchronous.Status);
        Assert.Null(synchronous.Result);
        Assert.Null(asynchronous.Result);
    }

    [Fact]
    public async Task SynchronousCancellationUsesCallerFirstArbitration()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        using var caller = new CancellationTokenSource();
        var entrypoint = new ControlledEntrypoint
        {
            Handler = (_, _, cancellation) =>
            {
                caller.Cancel();
                cancellation.ThrowIfCancellationRequested();
                throw new InvalidOperationException("cancellation was not forwarded");
            },
        };
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);

        var result = await service.InvokeAsync(
            TestBound(registry, entrypoint),
            InvocationRequest(),
            caller.Token);

        Assert.Equal(PlatformProviderInvocationStatus.CallerCancelled, result.Status);
        Assert.Null(result.Result);
    }

    [Fact]
    public async Task CallerCancellationDuringFinalHostCheckCannotPublishAResult()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        using var caller = new CancellationTokenSource();
        var entrypoint = new ControlledEntrypoint();
        var host = new RecordingHost(
            _ => throw new InvalidOperationException("must not bind"),
            (_, _) =>
            {
                caller.Cancel();
                return PlatformProviderHostBindingStatus.Bound;
            });
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            host,
            TimeProvider.System);

        var result = await service.InvokeAsync(
            TestBound(registry, entrypoint),
            InvocationRequest(),
            caller.Token);

        Assert.Equal(PlatformProviderInvocationStatus.CallerCancelled, result.Status);
        Assert.Null(result.Result);
    }

    [Fact]
    public async Task CallerCancellationWhileRegistryAdmissionIsBlockedWinsOverProviderBusy()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var bound = TestBound(registry, new ControlledEntrypoint());
        var claim = bound.Claim;
        using var first = Assert.IsType<PlatformProviderInvocationLease>(
            registry.TryAcquireInvocationLease(claim).Lease);
        using var second = Assert.IsType<PlatformProviderInvocationLease>(
            registry.TryAcquireInvocationLease(claim).Lease);
        var gate = Assert.IsType<object>(typeof(PlatformProviderRegistry)
            .GetField("_gate", BindingFlags.Instance | BindingFlags.NonPublic)!
            .GetValue(registry));
        using var gateHeld = new ManualResetEventSlim();
        using var releaseGate = new ManualResetEventSlim();
        var gateOwner = Task.Run(() =>
        {
            lock (gate)
            {
                gateHeld.Set();
                releaseGate.Wait(TimeSpan.FromSeconds(5));
            }
        });
        Assert.True(gateHeld.Wait(TimeSpan.FromSeconds(5)));
        using var caller = new CancellationTokenSource();
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);

        using var invocationStarted = new ManualResetEventSlim();
        Thread? invocationThread = null;
        var invocation = Task.Run(async () =>
        {
            invocationThread = Thread.CurrentThread;
            invocationStarted.Set();
            return await service.InvokeAsync(
                bound,
                InvocationRequest(),
                caller.Token);
        });
        Assert.True(invocationStarted.Wait(TimeSpan.FromSeconds(5)));
        Assert.True(SpinWait.SpinUntil(
            () => invocationThread!.ThreadState.HasFlag(ThreadState.WaitSleepJoin),
            TimeSpan.FromSeconds(5)));
        caller.Cancel();
        releaseGate.Set();
        var result = await invocation.WaitAsync(TimeSpan.FromSeconds(5));
        await gateOwner.WaitAsync(TimeSpan.FromSeconds(5));

        Assert.Equal(PlatformProviderInvocationStatus.CallerCancelled, result.Status);
        Assert.Null(result.Result);
    }

    [Fact]
    public async Task RequestEnvelopeDisclosesOnlyTheSelectedOperationsRequiredGrant()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var entrypoint = new ControlledEntrypoint
        {
            Handler = (_, requestJson, _) =>
            {
                using var request = JsonDocument.Parse(requestJson);
                Assert.Equal(
                    new[] { ItemLookup },
                    request.RootElement.GetProperty("grantedScopes")
                        .EnumerateArray()
                        .Select(value => value.GetString()));
                return Task.FromResult(ValidResponse());
            },
        };
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);

        var result = await service.InvokeAsync(
            TestBound(registry, entrypoint),
            InvocationRequest(),
            CancellationToken.None);

        Assert.Equal(PlatformProviderInvocationStatus.Succeeded, result.Status);
    }

    [Fact]
    public async Task RequestEnvelopeCarriesOnlyTheActualRemainingKernelDeadline()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var clock = new DeadlineProjectionTimeProvider(TimeSpan.FromMilliseconds(250));
        var entrypoint = new ControlledEntrypoint
        {
            Handler = (_, requestJson, _) =>
            {
                using var request = JsonDocument.Parse(requestJson);
                Assert.Equal(
                    750,
                    request.RootElement.GetProperty("remainingDeadlineMilliseconds").GetInt32());
                return Task.FromResult(ValidResponse());
            },
        };
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            clock);

        var result = await service.InvokeAsync(
            TestBound(registry, entrypoint),
            InvocationRequest(deadlineMilliseconds: 1_000),
            CancellationToken.None);

        Assert.Equal(PlatformProviderInvocationStatus.Succeeded, result.Status);
    }

    [Fact]
    public async Task ResponseFailureMatrixNeverPublishesPartialProviderData()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var entrypoint = new ControlledEntrypoint();
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);
        var bound = TestBound(registry, entrypoint);
        var cases = new (string? Response, PlatformProviderInvocationStatus Status)[]
        {
            (null, PlatformProviderInvocationStatus.ResponseMissing),
            (new string('x', PlatformProviderAbiContract.MaximumResponseDocumentBytes + 1),
                PlatformProviderInvocationStatus.ResponseTooLarge),
            ("{", PlatformProviderInvocationStatus.ResponseInvalidJson),
            ("{\"schemaVersion\":1,\"correlationId\":\"wrong\",\"protocol\":1,"
                + "\"result\":{\"message\":\"Hello\"}}",
                PlatformProviderInvocationStatus.ResponseEnvelopeMismatch),
            ("{\"schemaVersion\":1,\"correlationId\":\"test-call\",\"protocol\":1,"
                + "\"result\":{\"message\":\"\"}}",
                PlatformProviderInvocationStatus.ResponseSchemaRejected),
        };

        foreach (var testCase in cases)
        {
            entrypoint.Handler = (_, _, _) => Task.FromResult(testCase.Response!);

            var result = await service.InvokeAsync(
                bound,
                InvocationRequest(),
                CancellationToken.None);

            Assert.Equal(testCase.Status, result.Status);
            Assert.Null(result.Result);
        }
    }

    [Fact]
    public async Task CallerGenerationDeadlineAndIgnoredCancellationRemainDistinct()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var entrypoint = new ControlledEntrypoint();
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);
        var bound = TestBound(registry, entrypoint);

        var callerNever = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        entrypoint.Handler = (_, _, _) => callerNever.Task;
        using var caller = new CancellationTokenSource();
        var callerCall = service.InvokeAsync(bound, InvocationRequest(), caller.Token);
        Assert.True(SpinWait.SpinUntil(() => entrypoint.InvocationCount == 1, TimeSpan.FromSeconds(5)));
        caller.Cancel();
        var callerResult = await callerCall.WaitAsync(TimeSpan.FromSeconds(5));
        callerNever.SetResult(ValidResponse());

        var generationNever = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        entrypoint.Handler = (_, _, _) => generationNever.Task;
        var generationCall = service.InvokeAsync(bound, InvocationRequest(), CancellationToken.None);
        Assert.True(SpinWait.SpinUntil(() => entrypoint.InvocationCount == 2, TimeSpan.FromSeconds(5)));
        _ = registry.BeginReconciliation();
        var generationResult = await generationCall.WaitAsync(TimeSpan.FromSeconds(5));
        generationNever.SetResult(ValidResponse());

        Assert.Equal(PlatformProviderInvocationStatus.CallerCancelled, callerResult.Status);
        Assert.Equal(PlatformProviderInvocationStatus.GenerationCancelled, generationResult.Status);

        var deadlineRegistry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var deadlineEntrypoint = new ControlledEntrypoint
        {
            Handler = async (_, _, cancellation) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellation);
                return string.Empty;
            },
        };
        var deadlineService = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => deadlineRegistry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);
        var deadlineResult = await deadlineService.InvokeAsync(
            TestBound(deadlineRegistry, deadlineEntrypoint),
            InvocationRequest(deadlineMilliseconds: 1),
            CancellationToken.None);

        var ignoredRegistry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var ignoredNever = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var ignoredEntrypoint = new ControlledEntrypoint
        {
            Handler = (_, _, _) => ignoredNever.Task,
        };
        var ignoredService = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => ignoredRegistry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);
        var ignoredCall = ignoredService.InvokeAsync(
            TestBound(ignoredRegistry, ignoredEntrypoint),
            InvocationRequest(deadlineMilliseconds: 100),
            CancellationToken.None);
        Assert.True(SpinWait.SpinUntil(
            () => ignoredEntrypoint.InvocationCount == 1,
            TimeSpan.FromSeconds(5)));
        var ignoredResult = await ignoredCall;
        ignoredNever.SetResult(ValidResponse());

        Assert.Equal(PlatformProviderInvocationStatus.DeadlineExceeded, deadlineResult.Status);
        Assert.Equal(
            PlatformProviderInvocationStatus.ProviderIgnoredCancellation,
            ignoredResult.Status);
    }

    [Fact]
    public async Task RunawaysRetainZeroQueueBulkheadSlotsUntilActualCompletion()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var never = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entrypoint = new ControlledEntrypoint
        {
            Handler = (_, _, _) => never.Task,
        };
        var service = new PlatformProviderInvocationService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")),
            TimeProvider.System);
        var bound = TestBound(registry, entrypoint);
        using var firstCancellation = new CancellationTokenSource();
        using var secondCancellation = new CancellationTokenSource();
        var first = service.InvokeAsync(bound, InvocationRequest(), firstCancellation.Token);
        var second = service.InvokeAsync(bound, InvocationRequest(), secondCancellation.Token);
        Assert.True(SpinWait.SpinUntil(
            () => entrypoint.InvocationCount == PlatformProviderRegistry.MaximumConcurrentInvocationsPerProvider,
            TimeSpan.FromSeconds(5)));
        firstCancellation.Cancel();
        secondCancellation.Cancel();
        Assert.Equal(
            PlatformProviderInvocationStatus.CallerCancelled,
            (await first.WaitAsync(TimeSpan.FromSeconds(5))).Status);
        Assert.Equal(
            PlatformProviderInvocationStatus.CallerCancelled,
            (await second.WaitAsync(TimeSpan.FromSeconds(5))).Status);

        var saturated = await service.InvokeAsync(
            bound,
            InvocationRequest(),
            CancellationToken.None);

        Assert.Equal(PlatformProviderInvocationStatus.ProviderBusy, saturated.Status);
        Assert.Equal(
            PlatformProviderRegistry.MaximumConcurrentInvocationsPerProvider,
            entrypoint.InvocationCount);

        never.SetResult(ValidResponse());
        PlatformProviderInvocationResult afterCompletion = default;
        for (var attempt = 0; attempt < 100; attempt++)
        {
            await Task.Yield();
            afterCompletion = await service.InvokeAsync(
                bound,
                InvocationRequest(),
                CancellationToken.None);
            if (afterCompletion.Status != PlatformProviderInvocationStatus.ProviderBusy)
            {
                break;
            }
        }

        Assert.Equal(PlatformProviderInvocationStatus.Succeeded, afterCompletion.Status);
    }

    [Theory]
    [MemberData(nameof(HostRejections))]
    public void EveryHostRejectionMapsWithoutPublishingPartialBinding(
        int hostStatusValue,
        int expectedValue)
    {
        var hostStatus = (PlatformProviderHostBindingStatus)hostStatusValue;
        var expected = (PlatformProviderBindingStatus)expectedValue;
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var host = new RecordingHost(_ => PlatformProviderHostBindingResult.Rejected(hostStatus));

        var result = Service(registry, host).Bind(PluginId, OperationId, 1);

        Assert.Equal(expected, result.Status);
        Assert.Null(result.Binding);
        Assert.Single(host.Requests);
    }

    [Fact]
    public void RegistryRefusalsNeverReachTheForeignBindingHost()
    {
        var enabled = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var insufficient = EnabledRegistry(new[] { StorageRead });
        var pending = PendingRegistry();
        var host = new RecordingHost(_ => throw new InvalidOperationException("must not bind"));

        AssertRejected(
            Service(enabled, host).Bind(PluginId, "org.jellyfin.canopy.unknown", 1),
            PlatformProviderBindingStatus.OperationUnavailable);
        AssertRejected(
            Service(enabled, host).Bind(PluginId, OperationId, 2),
            PlatformProviderBindingStatus.ProtocolUnsupported);
        AssertRejected(
            Service(insufficient, host).Bind(PluginId, OperationId, 1),
            PlatformProviderBindingStatus.GrantInsufficient);
        AssertRejected(
            Service(pending, host).Bind(PluginId, OperationId, 1),
            PlatformProviderBindingStatus.AuthorityUnavailable);
        Assert.Empty(host.Requests);
    }

    [Fact]
    public void MissingEmbeddedSchemasRejectTheWholeBinding()
    {
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var type = typeof(LocalExactEntrypoint);
        var entrypoint = new LocalExactEntrypoint();
        var foreign = new PlatformProviderForeignEntrypoint(
            type.Assembly,
            entrypoint,
            type,
            entrypoint,
            type.GetMethod(nameof(LocalExactEntrypoint.InvokeAsync))!);

        var result = Service(
            registry,
            new RecordingHost(_ => PlatformProviderHostBindingResult.Bound(foreign)))
            .Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.SchemaMissing);
    }

    [Fact]
    public void AuthorityMutationDuringForeignBindingRejectsTheOtherwiseValidBinding()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var host = new RecordingHost(_ =>
        {
            registry.BeginReconciliation();
            return PlatformProviderHostBindingResult.Bound(foreign.Binding);
        });

        var result = Service(registry, host).Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.AuthorityChanged);
    }

    [Fact]
    public void AuthorityMutationAfterSchemaAdmissionRejectsTheOtherwiseValidBinding()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var service = new PlatformProviderBindingService(
            new Lazy<PlatformProviderRegistry>(() => registry),
            new RecordingHost(_ => PlatformProviderHostBindingResult.Bound(foreign.Binding)),
            (assembly, requestId, requestHash, responseId, responseHash) =>
            {
                var admitted = PlatformProviderEmbeddedSchemaAdmission.Admit(
                    assembly,
                    requestId,
                    requestHash,
                    responseId,
                    responseHash);
                Assert.Equal(PlatformProviderEmbeddedSchemaAdmissionStatus.Admitted, admitted.Status);
                registry.BeginReconciliation();
                return admitted;
            });

        var result = service.Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.AuthorityChanged);
    }

    [Fact]
    public void HostLifecycleChangeAfterSchemaAdmissionRejectsTheOtherwiseValidBinding()
    {
        using var foreign = AlphaForeignBinding.Load();
        var registry = EnabledRegistry(new[] { ItemLookup, StorageRead });
        var host = new RecordingHost(
            _ => PlatformProviderHostBindingResult.Bound(foreign.Binding),
            (_, _) => PlatformProviderHostBindingStatus.ProviderAbsent);

        var result = Service(registry, host).Bind(PluginId, OperationId, 1);

        AssertRejected(result, PlatformProviderBindingStatus.ProviderAbsent);
    }

    [Fact]
    public void UnexpectedRegistryAndHostFailuresAreClosedAndRedacted()
    {
        var hostFailure = Service(
            EnabledRegistry(new[] { ItemLookup, StorageRead }),
            new RecordingHost(_ => throw new InvalidOperationException("foreign details")))
            .Bind(PluginId, OperationId, 1);
        var registryFailure = new PlatformProviderBindingService(
            new Lazy<PlatformProviderRegistry>(() => throw new InvalidOperationException("store details")),
            new RecordingHost(_ => throw new InvalidOperationException("must not bind")))
            .Bind(PluginId, OperationId, 1);
        using var foreign = AlphaForeignBinding.Load();
        var revalidationFailure = Service(
            EnabledRegistry(new[] { ItemLookup, StorageRead }),
            new RecordingHost(
                _ => PlatformProviderHostBindingResult.Bound(foreign.Binding),
                (_, _) => throw new InvalidOperationException("host topology details")))
            .Bind(PluginId, OperationId, 1);

        AssertRejected(hostFailure, PlatformProviderBindingStatus.BindingFailed);
        AssertRejected(registryFailure, PlatformProviderBindingStatus.BindingFailed);
        AssertRejected(revalidationFailure, PlatformProviderBindingStatus.BindingFailed);
    }

    public static TheoryData<int, int>
        HostRejections => new()
        {
            { (int)PlatformProviderHostBindingStatus.ProviderAbsent, (int)PlatformProviderBindingStatus.ProviderAbsent },
            { (int)PlatformProviderHostBindingStatus.ProviderNotActive, (int)PlatformProviderBindingStatus.ProviderNotActive },
            { (int)PlatformProviderHostBindingStatus.HostIdentityChanged, (int)PlatformProviderBindingStatus.HostIdentityChanged },
            { (int)PlatformProviderHostBindingStatus.ProviderInstanceUnavailable, (int)PlatformProviderBindingStatus.ProviderInstanceUnavailable },
            { (int)PlatformProviderHostBindingStatus.EntrypointMissing, (int)PlatformProviderBindingStatus.EntrypointMissing },
            { (int)PlatformProviderHostBindingStatus.AbiMismatch, (int)PlatformProviderBindingStatus.AbiMismatch },
            { (int)PlatformProviderHostBindingStatus.ServiceUnavailable, (int)PlatformProviderBindingStatus.ServiceUnavailable },
            { (int)PlatformProviderHostBindingStatus.ServiceResolutionFailed, (int)PlatformProviderBindingStatus.ServiceResolutionFailed },
            { (int)PlatformProviderHostBindingStatus.BindingFailed, (int)PlatformProviderBindingStatus.BindingFailed },
        };

    private static PlatformProviderBindingService Service(
        PlatformProviderRegistry registry,
        IPlatformProviderBindingHost host) => new(new Lazy<PlatformProviderRegistry>(() => registry), host);

    private static PlatformProviderRegistry PendingRegistry()
    {
        var registry = Registry();
        Reconcile(registry);
        return registry;
    }

    private static PlatformProviderRegistry EnabledRegistry(IReadOnlyList<string> grants)
    {
        var registry = PendingRegistry();
        var entry = Assert.Single(registry.Snapshot.Entries);
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Apply(
                PlatformProviderAdminCommand.Approve(
                    registry.Snapshot.Revision,
                    PluginId,
                    entry.Generation,
                    entry.Fingerprint!,
                    grants,
                    "Approve provider binding service test"),
                AdminAuthorization()).Status);
        return registry;
    }

    private static PlatformProviderRegistry Registry() =>
        new(new RecordingStore(), new FixedTimeProvider(Now));

    private static void Reconcile(PlatformProviderRegistry registry)
    {
        var snapshot = PlatformInstalledManifestBindingTests.Snapshot(
            pluginId: PluginId,
            version: new Version(1, 0, 0, 0));
        var observation = PlatformInstalledManifestBinder.Bind(
            snapshot,
            PlatformInstalledManifestBindingTests.Snapshot(
                pluginId: PluginId,
                version: new Version(1, 0, 0, 0)),
            PlatformInstalledManifestReadResult.Acquired(
                File.ReadAllBytes(AlphaManifestPath()),
                "sha256:provider-binding-service-test"));
        var sweep = PlatformInstalledManifestSweep.EstablishCompleted(
            ImmutableArray.Create(observation));
        Assert.Equal(
            PlatformProviderRegistryMutationStatus.Applied,
            registry.Reconcile(registry.BeginReconciliation(), sweep).Status);
    }

    private static PlatformProviderAdminAuthorization AdminAuthorization()
    {
        var boundaryActor = PlatformActorTestFactory.Create(
            AdminId,
            isElevated: true,
            "provider-binding-service-test",
            "test-client",
            "test-device");
        return Assert.IsType<PlatformProviderAdminAuthorization>(
            PlatformProviderRegistryAdminBoundary.ReauthorizeElevatedAdministrator(
                boundaryActor,
                new ReauthorizationHost()));
    }

    private static void AssertRejected(
        PlatformProviderBindingResult result,
        PlatformProviderBindingStatus expected)
    {
        Assert.Equal(expected, result.Status);
        Assert.Null(result.Binding);
    }

    private static PlatformProviderBoundOperation TestBound(
        PlatformProviderRegistry registry,
        ControlledEntrypoint entrypoint)
    {
        var claim = Assert.IsType<PlatformProviderOperationBindingClaim>(
            registry.ClaimOperationBinding(PluginId, OperationId, 1).Claim);
        var type = entrypoint.GetType();
        var foreign = new PlatformProviderForeignEntrypoint(
            type.Assembly,
            entrypoint,
            type,
            entrypoint,
            type.GetMethod(nameof(ControlledEntrypoint.InvokeAsync))!);
        using var requestSchema = JsonDocument.Parse(
            "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\","
            + "\"$id\":\"urn:test:request\",\"type\":\"object\","
            + "\"additionalProperties\":false,\"required\":[\"name\"],"
            + "\"properties\":{\"name\":{\"type\":\"string\",\"minLength\":1,"
            + "\"maxLength\":64,\"x-canopy-maximum-utf8-bytes\":64}}}");
        using var responseSchema = JsonDocument.Parse(
            "{\"$schema\":\"https://json-schema.org/draft/2020-12/schema\","
            + "\"$id\":\"urn:test:response\",\"type\":\"object\","
            + "\"additionalProperties\":false,\"required\":[\"message\"],"
            + "\"properties\":{\"message\":{\"type\":\"string\",\"minLength\":1,"
            + "\"maxLength\":72,\"x-canopy-maximum-utf8-bytes\":72}}}");
        return new PlatformProviderBoundOperation(
            claim,
            foreign,
            PlatformProviderEmbeddedSchemaPair.EstablishAdmitted(
                requestSchema.RootElement,
                responseSchema.RootElement));
    }

    private static PlatformProviderInvocationRequest InvocationRequest(
        int deadlineMilliseconds = 30_000)
    {
        using var input = JsonDocument.Parse("{\"name\":\"Canopy\"}");
        return new PlatformProviderInvocationRequest(
            "test-call",
            "user-1",
            "device-1",
            itemId: null,
            surface: null,
            locale: "en-AU",
            accessibilityHints: ImmutableArray<string>.Empty,
            remainingDeadlineMilliseconds: deadlineMilliseconds,
            input.RootElement);
    }

    private static string ValidResponse() =>
        "{\"schemaVersion\":1,\"correlationId\":\"test-call\",\"protocol\":1,"
        + "\"result\":{\"message\":\"Hello, Canopy!\"}}";

    private static string AlphaManifestPath() => Path.Combine(
        RepositoryRoot(),
        "conformance",
        "platform-providers",
        "Jellyfin.Plugin.CanopyConformance.Alpha",
        "jellyfin-canopy-extension.json");

    private static string AlphaAssemblyPath() => Path.Combine(
        RepositoryRoot(),
        "conformance",
        "platform-providers",
        "Jellyfin.Plugin.CanopyConformance.Alpha",
        "bin",
        "Release",
        "net10.0",
        "Jellyfin.Plugin.CanopyConformance.Alpha.dll");

    private static string RepositoryRoot([CallerFilePath] string sourceFile = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourceFile)!, "..", ".."));

    private sealed class RecordingHost(
        Func<PlatformProviderHostBindingRequest, PlatformProviderHostBindingResult> bind,
        Func<PlatformProviderHostBindingRequest, PlatformProviderForeignEntrypoint,
            PlatformProviderHostBindingStatus>? revalidate = null)
        : IPlatformProviderBindingHost
    {
        internal List<PlatformProviderHostBindingRequest> Requests { get; } = [];

        public PlatformProviderHostBindingResult Bind(PlatformProviderHostBindingRequest request)
        {
            Requests.Add(request);
            return bind(request);
        }

        public PlatformProviderHostBindingStatus Revalidate(
            PlatformProviderHostBindingRequest request,
            PlatformProviderForeignEntrypoint binding) =>
            revalidate?.Invoke(request, binding) ?? PlatformProviderHostBindingStatus.Bound;
    }

    public sealed class ControlledEntrypoint
    {
        private int _invocationCount;

        internal Func<string, string, CancellationToken, Task<string>> Handler { get; set; } =
            (_, _, _) => Task.FromResult(ValidResponse());

        internal int InvocationCount => Volatile.Read(ref _invocationCount);

        public Task<string> InvokeAsync(
            string operationId,
            string requestJson,
            CancellationToken cancellationToken)
        {
            Interlocked.Increment(ref _invocationCount);
            return Handler(operationId, requestJson, cancellationToken);
        }
    }

    private sealed class DeadlineProjectionTimeProvider(TimeSpan elapsed) : TimeProvider
    {
        private long _timestamp;

        public override long TimestampFrequency => 1_000;

        public override long GetTimestamp() => Volatile.Read(ref _timestamp);

        public override ITimer CreateTimer(
            TimerCallback callback,
            object? state,
            TimeSpan dueTime,
            TimeSpan period)
        {
            _ = callback;
            _ = state;
            _ = dueTime;
            _ = period;
            Interlocked.Exchange(ref _timestamp, (long)elapsed.TotalMilliseconds);
            return new NoOpTimer();
        }

        private sealed class NoOpTimer : ITimer
        {
            public bool Change(TimeSpan dueTime, TimeSpan period) => true;

            public void Dispose()
            {
            }

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }

    private sealed class AlphaForeignBinding : IDisposable
    {
        private readonly AssemblyLoadContext _loadContext;

        private AlphaForeignBinding(
            AssemblyLoadContext loadContext,
            IPlugin pluginInstance,
            PlatformProviderForeignEntrypoint binding)
        {
            _loadContext = loadContext;
            PluginInstance = pluginInstance;
            Binding = binding;
        }

        internal IPlugin PluginInstance { get; }

        internal PlatformProviderForeignEntrypoint Binding { get; }

        internal static AlphaForeignBinding Load()
        {
            var loadContext = new AssemblyLoadContext(
                "provider-binding-service-alpha-" + Guid.NewGuid().ToString("N"),
                isCollectible: true);
            var assembly = loadContext.LoadFromAssemblyPath(AlphaAssemblyPath());
            var type = assembly.GetType(PlatformProviderAbiContract.EntrypointTypeName)
                ?? throw new InvalidOperationException("The Alpha fixture entrypoint is missing.");
            var instance = Activator.CreateInstance(type)!;
            var pluginType = assembly.GetType(
                "Jellyfin.Plugin.CanopyConformance.Alpha.AlphaPlugin")
                ?? throw new InvalidOperationException("The Alpha fixture plugin type is missing.");
            var pluginInstance = Assert.IsAssignableFrom<IPlugin>(
                RuntimeHelpers.GetUninitializedObject(pluginType));
            var method = Assert.Single(type.GetMethods(BindingFlags.Public | BindingFlags.Instance),
                candidate => candidate.Name == PlatformProviderAbiContract.InvocationMethodName);
            return new AlphaForeignBinding(
                loadContext,
                pluginInstance,
                new PlatformProviderForeignEntrypoint(
                    assembly,
                    pluginInstance,
                    type,
                    instance,
                    method));
        }

        public void Dispose() => _loadContext.Unload();
    }

    private sealed class RecordingStore : IPlatformProviderRegistryStateStore
    {
        private PlatformProviderRegistryDurableState _state = PlatformProviderRegistryDurableState.Empty;

        public PlatformProviderRegistryStoreLoadResult Load() =>
            PlatformProviderRegistryStoreLoadResult.Healthy(_state);

        public void Save(PlatformProviderRegistryDurableState state) => _state = state;

        public void ResetQuarantined(Guid administratorId, string reason, DateTimeOffset decidedAtUtc) =>
            _state = PlatformProviderRegistryDurableState.Empty;

        public void FenceQuarantined()
        {
        }
    }

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
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

    public sealed class LocalExactEntrypoint
    {
        public Task<string> InvokeAsync(
            string operationId,
            string requestJson,
            CancellationToken cancellationToken) => Task.FromResult("{}");
    }
}
