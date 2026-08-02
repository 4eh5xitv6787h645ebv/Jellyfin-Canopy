using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class PlatformRequestLifecycleTests
    {
        [Fact]
        public async Task ResourceFilterInstallsLinkedTokenBeforeModelBindingAndRestoresCallerToken()
        {
            using var caller = new CancellationTokenSource();
            var http = new DefaultHttpContext { RequestAborted = caller.Token };
            var context = ResourceContext(http);
            var observed = default(CancellationToken);

            await new PlatformRequestLifecycleFilter().OnResourceExecutionAsync(context, () =>
            {
                observed = http.RequestAborted;
                Assert.NotEqual(caller.Token, observed);
                caller.Cancel();
                Assert.True(observed.IsCancellationRequested);
                return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
            });

            Assert.Equal(caller.Token, http.RequestAborted);
        }

        [Fact]
        public async Task AdvancingDeadlineCancelsLinkedTokenButNotCallerToken()
        {
            var clock = new ManualTimeProvider(new DateTimeOffset(2026, 8, 3, 0, 0, 0, TimeSpan.Zero));
            using var caller = new CancellationTokenSource();
            var http = new DefaultHttpContext { RequestAborted = caller.Token };
            var context = ResourceContext(http);

            await new PlatformRequestLifecycleFilter(clock).OnResourceExecutionAsync(context, () =>
            {
                var linked = http.RequestAborted;
                clock.Advance(PlatformConstants.RequestDeadline);

                Assert.True(linked.IsCancellationRequested);
                Assert.False(caller.IsCancellationRequested);
                return Task.FromResult(new ResourceExecutedContext(context, new List<IFilterMetadata>()));
            });
        }

        [Fact]
        public async Task DeadlineTokenMapsTo504WithoutPretendingCallerAborted()
        {
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext { RequestAborted = CancellationTokenSource.CreateLinkedTokenSource(caller.Token, deadline.Token).Token };
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            deadline.Cancel();
            var context = ActionContext(http);
            var executed = new ActionExecutedContext(context, new List<IFilterMetadata>(), new object())
            {
                Result = new OkObjectResult(new { ignored = true }),
            };

            await new PlatformRequestLifecycleFilter().OnActionExecutionAsync(context, () =>
                Task.FromResult(executed));

            Assert.False(caller.IsCancellationRequested);
            Assert.Equal(caller.Token, http.RequestAborted);
            var result = Assert.IsType<ObjectResult>(executed.Result);
            var error = Assert.IsType<PlatformError>(result.Value);
            Assert.Equal(504, result.StatusCode);
            Assert.Equal(PlatformErrorCode.Timeout, error.Code);
        }

        [Fact]
        public async Task CancellationIgnoringActionIsAwaitedThenItsSuccessBecomesTimeout()
        {
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext();
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            var context = ActionContext(http);
            var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            var executed = new ActionExecutedContext(context, new List<IFilterMetadata>(), new object())
            {
                Result = new OkObjectResult(new { ignoredCancellation = true }),
            };

            var filtering = new PlatformRequestLifecycleFilter().OnActionExecutionAsync(context, async () =>
            {
                entered.TrySetResult();
                await release.Task;
                return executed;
            });
            await entered.Task;
            deadline.Cancel();

            Assert.False(filtering.IsCompleted);
            release.TrySetResult();
            await filtering;

            var timeout = Assert.IsType<ObjectResult>(executed.Result);
            Assert.Equal(PlatformErrorCode.Timeout, Assert.IsType<PlatformError>(timeout.Value).Code);
        }

        [Fact]
        public async Task CallerCancellationWinsASimultaneousRaceAndSelectsNoPayload()
        {
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext();
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            caller.Cancel();
            deadline.Cancel();
            var context = ActionContext(http);
            var executed = new ActionExecutedContext(context, new List<IFilterMetadata>(), new object())
            {
                Exception = new OperationCanceledException(),
            };

            await new PlatformRequestLifecycleFilter().OnActionExecutionAsync(context, () =>
                Task.FromResult(executed));

            Assert.IsType<EmptyResult>(executed.Result);
            Assert.Empty(http.Response.Headers);
        }

        [Fact]
        public void LifecycleIsImmediatelyInsideBoundedBodyAndBeforeModelBinding()
        {
            var filters = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .ToDictionary(attribute => attribute.ImplementationType, attribute => attribute.Order);

            Assert.Equal(filters[typeof(PlatformBoundedBodyFilter)] + 1, filters[typeof(PlatformRequestLifecycleFilter)]);
            Assert.IsAssignableFrom<IAsyncResourceFilter>(new PlatformRequestLifecycleFilter());
            Assert.IsAssignableFrom<IAsyncActionFilter>(new PlatformRequestLifecycleFilter());
            Assert.IsAssignableFrom<IAsyncAlwaysRunResultFilter>(new PlatformRequestLifecycleFilter());
            Assert.False(typeof(IAuthorizationFilter).IsAssignableFrom(typeof(PlatformRequestLifecycleFilter)));
            Assert.False(typeof(IAsyncAuthorizationFilter).IsAssignableFrom(typeof(PlatformRequestLifecycleFilter)));
            Assert.Equal(TimeSpan.FromSeconds(30), PlatformConstants.RequestDeadline);

            var derived = typeof(PlatformControllerBase).Assembly.GetTypes()
                .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type));
            Assert.All(derived, type => Assert.Contains(
                type.GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true).Cast<TypeFilterAttribute>(),
                attribute => attribute.ImplementationType == typeof(PlatformRequestLifecycleFilter)));
        }

        [Fact]
        public void LifecycleContainmentDoesNotRaceWorkAgainstDetachedDelayTasks()
        {
            var root = FindRepositoryRoot();
            var source = File.ReadAllText(Path.Combine(
                root,
                "Jellyfin.Plugin.JellyfinCanopy",
                "Platform",
                "PlatformRequestLifecycleFilter.cs"));

            Assert.DoesNotContain("Task.WhenAny", source, StringComparison.Ordinal);
            Assert.DoesNotContain("Task.Delay", source, StringComparison.Ordinal);
            Assert.DoesNotContain("ExecuteResultAsync", source, StringComparison.Ordinal);
        }

        [Fact]
        public async Task InvalidModelStateRestoresCallerTokenBeforeSelectingError()
        {
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(caller.Token, deadline.Token);
            var http = new DefaultHttpContext { RequestAborted = linked.Token };
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            var context = ActionContext(http);
            context.ModelState.AddModelError("Name", "invalid");

            await new PlatformRequestFilter(NullLogger<PlatformRequestFilter>.Instance)
                .OnActionExecutionAsync(context, () => throw new Xunit.Sdk.XunitException("Invalid model must short-circuit."));

            Assert.Equal(caller.Token, http.RequestAborted);
            Assert.IsType<ObjectResult>(context.Result);
        }

        [Fact]
        public async Task ResourceExceptionRestoresOriginalTokenAndRemovesLifecycleState()
        {
            using var caller = new CancellationTokenSource();
            var http = new DefaultHttpContext { RequestAborted = caller.Token };
            var context = ResourceContext(http);

            await Assert.ThrowsAsync<InvalidOperationException>(() =>
                new PlatformRequestLifecycleFilter().OnResourceExecutionAsync(
                    context,
                    () => throw new InvalidOperationException("resource failure")));

            Assert.Equal(caller.Token, http.RequestAborted);
            Assert.False(http.Items.ContainsKey(PlatformRequestLifecycleState.ItemKey));
        }

        [Fact]
        public async Task StartedResponseDeadlineSuppressesFurtherResultWrites()
        {
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext();
            http.Features.Set<IHttpResponseFeature>(new StartedResponseFeature());
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            deadline.Cancel();
            Assert.True(http.Response.HasStarted);
            var action = new ActionContext(http, new RouteData(), new ControllerActionDescriptor());
            var context = new ResultExecutingContext(
                action,
                new List<IFilterMetadata>(),
                new OkObjectResult(new { tooLate = true }),
                new object());
            var continued = false;

            await new PlatformRequestLifecycleFilter().OnResultExecutionAsync(context, () =>
            {
                continued = true;
                return Task.FromResult(new ResultExecutedContext(action, new List<IFilterMetadata>(), context.Result, new object()));
            });

            Assert.True(context.Cancel);
            Assert.False(continued);
            Assert.Empty(http.Response.Headers);
        }

        private static ResourceExecutingContext ResourceContext(HttpContext http) => new(
            new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
            new List<IFilterMetadata>(),
            new List<IValueProviderFactory>());

        private static ActionExecutingContext ActionContext(HttpContext http) => new(
            new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
            new List<IFilterMetadata>(),
            new Dictionary<string, object?>(),
            new object());

        private static string FindRepositoryRoot()
        {
            var directory = new DirectoryInfo(AppContext.BaseDirectory);
            while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "JellyfinCanopy.slnx")))
            {
                directory = directory.Parent;
            }

            return directory?.FullName ?? throw new DirectoryNotFoundException("Repository root not found.");
        }

        private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
        {
            private readonly List<ManualTimer> _timers = new();
            private DateTimeOffset _now = now;

            public override DateTimeOffset GetUtcNow() => _now;

            public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period)
            {
                var timer = new ManualTimer(this, callback, state, dueTime, period);
                _timers.Add(timer);
                return timer;
            }

            internal void Advance(TimeSpan amount)
            {
                _now += amount;
                foreach (var timer in _timers.ToArray())
                {
                    timer.FireIfDue(_now);
                }
            }

            private sealed class ManualTimer : ITimer
            {
                private readonly ManualTimeProvider _owner;
                private readonly TimerCallback _callback;
                private readonly object? _state;
                private TimeSpan _period;
                private DateTimeOffset? _dueAt;
                private bool _disposed;

                internal ManualTimer(
                    ManualTimeProvider owner,
                    TimerCallback callback,
                    object? state,
                    TimeSpan dueTime,
                    TimeSpan period)
                {
                    _owner = owner;
                    _callback = callback;
                    _state = state;
                    Change(dueTime, period);
                }

                public bool Change(TimeSpan dueTime, TimeSpan period)
                {
                    if (_disposed)
                    {
                        return false;
                    }

                    _period = period;
                    _dueAt = dueTime == Timeout.InfiniteTimeSpan ? null : _owner._now + dueTime;
                    return true;
                }

                public void Dispose() => _disposed = true;

                public ValueTask DisposeAsync()
                {
                    Dispose();
                    return ValueTask.CompletedTask;
                }

                internal void FireIfDue(DateTimeOffset now)
                {
                    if (_disposed || _dueAt is null || _dueAt > now)
                    {
                        return;
                    }

                    _dueAt = _period == Timeout.InfiniteTimeSpan ? null : now + _period;
                    _callback(_state);
                }
            }
        }
    }

    internal sealed class StartedResponseFeature : IHttpResponseFeature
    {
        public int StatusCode { get; set; } = StatusCodes.Status200OK;

        public string? ReasonPhrase { get; set; }

        public IHeaderDictionary Headers { get; set; } = new HeaderDictionary();

        public Stream Body { get; set; } = Stream.Null;

        public bool HasStarted => true;

        public void OnStarting(Func<object, Task> callback, object state)
        {
        }

        public void OnCompleted(Func<object, Task> callback, object state)
        {
        }
    }
}
