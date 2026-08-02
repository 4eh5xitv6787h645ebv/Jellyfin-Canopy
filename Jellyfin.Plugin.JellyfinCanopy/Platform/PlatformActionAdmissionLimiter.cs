using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    internal enum PlatformActionAdmissionKind
    {
        Acquired,
        AtCapacity,
    }

    internal sealed class PlatformActionAdmission : IDisposable
    {
        private readonly PlatformActionAdmissionLimiter? _owner;
        private readonly PlatformActionAdmissionLimiter.ActionKey? _key;
        private int _released;

        internal PlatformActionAdmission(
            PlatformActionAdmissionKind kind,
            PlatformActionAdmissionLimiter? owner = null,
            PlatformActionAdmissionLimiter.ActionKey? key = null)
        {
            Kind = kind;
            _owner = owner;
            _key = key;
        }

        internal PlatformActionAdmissionKind Kind { get; }

        public void Dispose()
        {
            if (Kind == PlatformActionAdmissionKind.Acquired
                && Interlocked.Exchange(ref _released, 1) == 0)
            {
                _owner!.Release(_key!.Value);
            }
        }
    }

    /// <summary>
    /// Fair bounded admission per authoritative actor and closed operation. One leader
    /// runs per key; waiting and retained-key state are both independently capped.
    /// </summary>
    public sealed class PlatformActionAdmissionLimiter
    {
        public const int MaximumKeys = 1024;

        public const int MaximumWaitersPerKey = 8;

        public const int MaximumWaiters = 1024;

        private readonly object _gate = new();
        private readonly Dictionary<ActionKey, Gate> _gates = new();
        private int _waiterCount;

        internal Task<PlatformActionAdmission> AcquireAsync(
            PlatformActor actor,
            PlatformOperationDefinition operation,
            CancellationToken cancellationToken)
        {
            ArgumentNullException.ThrowIfNull(actor);
            ArgumentNullException.ThrowIfNull(operation);
            cancellationToken.ThrowIfCancellationRequested();
            if (!ReferenceEquals(PlatformOperationVocabulary.Find(operation.Id.Value), operation))
            {
                return Task.FromResult(new PlatformActionAdmission(PlatformActionAdmissionKind.AtCapacity));
            }

            var key = new ActionKey(actor.UserId, operation.Id.Value);
            Waiter? waiter = null;
            lock (_gate)
            {
                if (!_gates.TryGetValue(key, out var gate))
                {
                    if (_gates.Count >= MaximumKeys)
                    {
                        return Task.FromResult(new PlatformActionAdmission(PlatformActionAdmissionKind.AtCapacity));
                    }

                    gate = new Gate();
                    _gates.Add(key, gate);
                }

                if (!gate.Active)
                {
                    gate.Active = true;
                    return Task.FromResult(
                        new PlatformActionAdmission(PlatformActionAdmissionKind.Acquired, this, key));
                }

                if (gate.Waiters.Count >= MaximumWaitersPerKey || _waiterCount >= MaximumWaiters)
                {
                    return Task.FromResult(new PlatformActionAdmission(PlatformActionAdmissionKind.AtCapacity));
                }

                waiter = new Waiter(cancellationToken);
                waiter.Node = gate.Waiters.AddLast(waiter);
                _waiterCount++;
            }

            waiter.Registration = cancellationToken.Register(
                static state =>
                {
                    var registration = (CancellationRegistration)state!;
                    registration.Owner.CancelWaiter(registration.Key, registration.Waiter);
                },
                new CancellationRegistration(this, key, waiter));
            return AwaitWaiterAsync(waiter);
        }

        internal int KeyCount
        {
            get
            {
                lock (_gate)
                {
                    return _gates.Count;
                }
            }
        }

        internal int WaiterCount
        {
            get
            {
                lock (_gate)
                {
                    return _waiterCount;
                }
            }
        }

        private static async Task<PlatformActionAdmission> AwaitWaiterAsync(Waiter waiter)
        {
            try
            {
                return await waiter.Completion.Task.ConfigureAwait(false);
            }
            finally
            {
                await waiter.Registration.DisposeAsync().ConfigureAwait(false);
            }
        }

        private void CancelWaiter(ActionKey key, Waiter waiter)
        {
            var removed = false;
            lock (_gate)
            {
                if (_gates.TryGetValue(key, out var gate)
                    && waiter.Node?.List is not null)
                {
                    gate.Waiters.Remove(waiter.Node);
                    waiter.Node = null;
                    _waiterCount--;
                    removed = true;
                    RemoveIdle(key, gate);
                }
            }

            if (removed)
            {
                waiter.Completion.TrySetCanceled(waiter.CancellationToken);
            }
        }

        internal void Release(ActionKey key)
        {
            Waiter? next = null;
            lock (_gate)
            {
                if (!_gates.TryGetValue(key, out var gate) || !gate.Active)
                {
                    return;
                }

                while (gate.Waiters.First is LinkedListNode<Waiter> node)
                {
                    gate.Waiters.RemoveFirst();
                    node.Value.Node = null;
                    _waiterCount--;
                    if (!node.Value.CancellationToken.IsCancellationRequested)
                    {
                        next = node.Value;
                        break;
                    }

                    node.Value.Completion.TrySetCanceled(node.Value.CancellationToken);
                }

                if (next is null)
                {
                    gate.Active = false;
                    RemoveIdle(key, gate);
                }
            }

            next?.Completion.TrySetResult(
                new PlatformActionAdmission(PlatformActionAdmissionKind.Acquired, this, key));
        }

        private void RemoveIdle(ActionKey key, Gate gate)
        {
            if (!gate.Active && gate.Waiters.Count == 0)
            {
                _gates.Remove(key);
            }
        }

        internal readonly record struct ActionKey(Guid ActorUserId, string OperationId);

        private sealed class Gate
        {
            internal bool Active { get; set; }

            internal LinkedList<Waiter> Waiters { get; } = new();
        }

        private sealed class Waiter
        {
            internal Waiter(CancellationToken cancellationToken)
            {
                CancellationToken = cancellationToken;
                Completion = new TaskCompletionSource<PlatformActionAdmission>(
                    TaskCreationOptions.RunContinuationsAsynchronously);
            }

            internal CancellationToken CancellationToken { get; }

            internal TaskCompletionSource<PlatformActionAdmission> Completion { get; }

            internal LinkedListNode<Waiter>? Node { get; set; }

            internal CancellationTokenRegistration Registration { get; set; }
        }

        private sealed record CancellationRegistration(
            PlatformActionAdmissionLimiter Owner,
            ActionKey Key,
            Waiter Waiter);
    }
}
