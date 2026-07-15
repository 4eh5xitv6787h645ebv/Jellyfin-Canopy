# Watchlist worker #106 bounded-load benchmark

The regression harness submits 15,000 distinct work keys while the single consumer is
deliberately blocked. It records the worker-task count, accepted calls, queue depth, elapsed
producer time, and process-wide managed allocations. The assertions deliberately avoid a
machine-specific time or allocation threshold; they enforce the structural bounds instead.

Run on 2026-07-15 with .NET 10.0.9:

```text
events=15000 workerTasks=1 capacity=64 accepted=64 dropped=14936 peakDepth=63 callsWhileBlocked=1 elapsedMs=6.815 allocatedBytes=6088
```

Reproduce with:

```bash
dotnet test Jellyfin.Plugin.JellyfinCanopy.Tests/JellyfinCanopy.Tests.csproj \
  --filter 'FullyQualifiedName~DistinctEventStorm_RejectsBeyondFixedCapacityWithoutCreatingTasks' \
  --logger 'console;verbosity=detailed'
```

The production `WatchlistMonitor` uses the same primitive at a capacity of 1,024. A separate
monitor integration test raises 10,000 duplicate Jellyfin library events for one item while the
worker is active and proves they retain one state entry, one owned worker task, zero drops, and
exactly one follow-up operation containing the newest event.
