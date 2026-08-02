using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Authorization;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Correlation ids, and the authorization boundary the envelope must stay on the
    /// correct side of.
    /// </summary>
    public class PlatformCorrelationTests
    {
        /// <summary>Records scopes and entries so the round-trip can be asserted rather than assumed.</summary>
        private sealed class RecordingLogger : ILogger<PlatformRequestFilter>
        {
            public List<IReadOnlyDictionary<string, object>> Scopes { get; } = new();

            public List<(LogLevel Level, string Message, Exception? Exception)> Entries { get; } = new();

            public IDisposable BeginScope<TState>(TState state)
                where TState : notnull
            {
                if (state is IEnumerable<KeyValuePair<string, object>> pairs)
                {
                    Scopes.Add(pairs.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal));
                }

                return new NoopScope();
            }

            public bool IsEnabled(LogLevel logLevel) => true;

            public void Log<TState>(
                LogLevel logLevel,
                EventId eventId,
                TState state,
                Exception? exception,
                Func<TState, Exception?, string> formatter)
            {
                Entries.Add((logLevel, formatter(state, exception), exception));
            }

            private sealed class NoopScope : IDisposable
            {
                public void Dispose()
                {
                }
            }
        }

        private sealed class ProbeController : PlatformControllerBase
        {
            public string ExposedCorrelationId => CorrelationId;
        }

        private static ActionExecutingContext ActionContext(HttpContext http) => new(
            new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
            new List<IFilterMetadata>(),
            new Dictionary<string, object?>(),
            controller: new object());

        [Fact]
        public void TheSameIdIsUsedThroughoutOneRequest()
        {
            // An id that differs between the header, the body and the log correlates
            // nothing at all, so stability within a request is the entire property.
            var http = new DefaultHttpContext();

            Assert.Equal(PlatformCorrelation.For(http), PlatformCorrelation.For(http));
        }

        [Fact]
        public void DifferentRequestsGetDifferentIds()
        {
            Assert.NotEqual(PlatformCorrelation.For(new DefaultHttpContext()), PlatformCorrelation.For(new DefaultHttpContext()));
        }

        [Fact]
        public void IdsAreOpaqueLowercaseHexCarryingNoStructure()
        {
            // No dashes, no ordering, no embedded time: nothing a consumer could come to
            // depend on, and nothing that leaks request volume.
            var id = PlatformCorrelation.Generate();

            Assert.Equal(32, id.Length);
            Assert.All(id, character => Assert.Contains(character, "0123456789abcdef"));
        }

        [Fact]
        public async Task TheIdIsReturnedOnTheResponseAndScopedOntoEveryLogLine()
        {
            // The round-trip the issue asks for: body, header and log all agree.
            var logger = new RecordingLogger();
            var http = new DefaultHttpContext();
            var context = ActionContext(http);

            var scopedIdDuringAction = string.Empty;
            await new PlatformRequestFilter(logger).OnActionExecutionAsync(context, () =>
            {
                scopedIdDuringAction = (string)logger.Scopes.Single()["CorrelationId"];
                return Task.FromResult(new ActionExecutedContext(context, new List<IFilterMetadata>(), controller: new object()));
            });

            var header = http.Response.Headers["X-Correlation-Id"].ToString();

            Assert.False(string.IsNullOrEmpty(header));
            Assert.Equal(header, scopedIdDuringAction);
            Assert.Equal(header, PlatformCorrelation.For(http));
        }

        [Fact]
        public async Task AnUnhandledFailureBecomesTheEnvelopeAndLeaksNothing()
        {
            var logger = new RecordingLogger();
            var http = new DefaultHttpContext();
            var context = new ExceptionContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
                new List<IFilterMetadata>())
            {
                Exception = new InvalidOperationException("connection string is Server=db;Password=hunter2"),
            };

            await new PlatformRequestFilter(logger).OnExceptionAsync(context);

            var result = Assert.IsType<ObjectResult>(context.Result);
            var payload = Assert.IsType<PlatformError>(result.Value);

            Assert.Equal(500, result.StatusCode);
            Assert.Equal(PlatformErrorCode.InternalError, payload.Code);
            Assert.True(payload.Retryable);
            Assert.Equal(PlatformCorrelation.For(http), payload.CorrelationId);

            // The detail exists, but only server-side, joined to the response solely by
            // the correlation id.
            Assert.DoesNotContain("hunter2", payload.Message, StringComparison.Ordinal);
            Assert.DoesNotContain("InvalidOperationException", payload.Message, StringComparison.Ordinal);
            Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Error && entry.Exception is not null);

            // Handled, so the host's default error page cannot replace the envelope with
            // a different shape.
            Assert.True(context.ExceptionHandled);
        }

        [Fact]
        public async Task CallerCancellationIsHandledWithoutAWriteOrServerFaultLog()
        {
            var logger = new RecordingLogger();
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext();
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            caller.Cancel();
            var context = new ExceptionContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
                new List<IFilterMetadata>())
            {
                Exception = new OperationCanceledException(),
            };

            await new PlatformRequestFilter(logger).OnExceptionAsync(context);

            Assert.True(context.ExceptionHandled);
            Assert.IsType<EmptyResult>(context.Result);
            Assert.Empty(http.Response.Headers);
            Assert.Empty(logger.Entries);
        }

        [Fact]
        public async Task CallerCancellationDuringActionPublishesNoDeferredCorrelationHeader()
        {
            var logger = new RecordingLogger();
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext();
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            var context = ActionContext(http);

            await new PlatformRequestFilter(logger).OnActionExecutionAsync(context, () =>
            {
                caller.Cancel();
                return Task.FromResult(new ActionExecutedContext(context, new List<IFilterMetadata>(), new object())
                {
                    Result = new EmptyResult(),
                });
            });

            Assert.Empty(http.Response.Headers);
            Assert.Empty(logger.Entries);
        }

        [Fact]
        public async Task DeadlineCancellationUsesTimeoutWithoutAFalseServerFaultLog()
        {
            var logger = new RecordingLogger();
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(caller.Token, deadline.Token);
            var http = new DefaultHttpContext { RequestAborted = linked.Token };
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            deadline.Cancel();
            var context = new ExceptionContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
                new List<IFilterMetadata>())
            {
                Exception = new OperationCanceledException(),
            };

            await new PlatformRequestFilter(logger).OnExceptionAsync(context);

            var result = Assert.IsType<ObjectResult>(context.Result);
            Assert.Equal(504, result.StatusCode);
            Assert.Equal(PlatformErrorCode.Timeout, Assert.IsType<PlatformError>(result.Value).Code);
            Assert.Equal(caller.Token, http.RequestAborted);
            Assert.DoesNotContain(logger.Entries, entry => entry.Level == LogLevel.Error);
        }

        [Fact]
        public async Task UnrelatedCancellationRemainsAnInternalErrorAndIsLogged()
        {
            var logger = new RecordingLogger();
            using var caller = new CancellationTokenSource();
            using var deadline = new CancellationTokenSource();
            var http = new DefaultHttpContext();
            http.Items[PlatformRequestLifecycleState.ItemKey] = new PlatformRequestLifecycleState(caller.Token, deadline.Token);
            var context = new ExceptionContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
                new List<IFilterMetadata>())
            {
                Exception = new OperationCanceledException("not a Platform token"),
            };

            await new PlatformRequestFilter(logger).OnExceptionAsync(context);

            var result = Assert.IsType<ObjectResult>(context.Result);
            Assert.Equal(PlatformErrorCode.InternalError, Assert.IsType<PlatformError>(result.Value).Code);
            Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Error);
        }

        [Fact]
        public async Task StartedResponseGenericFailureLogsButAttemptsNoReplacementWrite()
        {
            var logger = new RecordingLogger();
            var http = new DefaultHttpContext();
            http.Features.Set<IHttpResponseFeature>(new StartedResponseFeature());
            Assert.True(http.Response.HasStarted);
            var context = new ExceptionContext(
                new ActionContext(http, new RouteData(), new ControllerActionDescriptor()),
                new List<IFilterMetadata>())
            {
                Exception = new InvalidOperationException("after response start"),
            };

            await new PlatformRequestFilter(logger).OnExceptionAsync(context);

            Assert.True(context.ExceptionHandled);
            Assert.IsType<EmptyResult>(context.Result);
            Assert.Contains(logger.Entries, entry => entry.Level == LogLevel.Error);
            Assert.Empty(http.Response.Headers);
        }

        [Fact]
        public void TheEnvelopeCannotReach401Or403BecauseItIsAnActionFilter()
        {
            // ADR-0002 requires 401/403 to stay bare, and EP-00 measured that Jellyfin 12
            // returns both with zero body bytes. What GUARANTEES that here is placement:
            // authorization filters run before action filters, so an unauthenticated
            // request short-circuits before this type executes at all.
            //
            // Were this middleware, or an authorization filter, it would run first and
            // wrap those responses. Asserting the interfaces is asserting the ordering.
            var filter = typeof(PlatformRequestFilter);

            Assert.True(typeof(IAsyncActionFilter).IsAssignableFrom(filter));
            Assert.True(typeof(IAsyncExceptionFilter).IsAssignableFrom(filter));

            Assert.False(typeof(IAuthorizationFilter).IsAssignableFrom(filter));
            Assert.False(typeof(IAsyncAuthorizationFilter).IsAssignableFrom(filter));
            Assert.False(typeof(IResourceFilter).IsAssignableFrom(filter));
            Assert.False(typeof(IAsyncResourceFilter).IsAssignableFrom(filter));
        }

        [Fact]
        public void TheAuthorizationFilterThatShortCircuitsRunsBeforeThisOne()
        {
            // The other half of the ordering argument, taken from the framework rather
            // than from prose: MVC's own AuthorizeFilter sorts ahead of an action filter.
            Assert.True(
                typeof(IAsyncAuthorizationFilter).IsAssignableFrom(typeof(AuthorizeFilter)),
                "The [Authorize] on PlatformControllerBase is enforced by an authorization filter, "
                + "which is the stage that short-circuits before any action filter runs.");
        }

        [Fact]
        public void EveryPlatformControllerCarriesTheFilter()
        {
            // Inherited from the base, so a new controller gets correlation and the
            // envelope without opting in - the same fail-closed shape as authorization.
            var attribute = typeof(PlatformControllerBase)
                .GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true)
                .Cast<TypeFilterAttribute>()
                .SingleOrDefault(candidate => candidate.ImplementationType == typeof(PlatformRequestFilter));

            Assert.NotNull(attribute);

            var derived = typeof(PlatformControllerBase).Assembly
                .GetTypes()
                .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type));

            Assert.All(derived, type => Assert.Contains(
                type.GetCustomAttributes(typeof(TypeFilterAttribute), inherit: true).Cast<TypeFilterAttribute>(),
                candidate => candidate.ImplementationType == typeof(PlatformRequestFilter)));
        }

        [Fact]
        public void ControllersReadTheSameIdTheFilterPublished()
        {
            var http = new DefaultHttpContext();
            var controller = new ProbeController
            {
                ControllerContext = new ControllerContext { HttpContext = http, RouteData = new RouteData() },
            };

            Assert.Equal(PlatformCorrelation.For(http), controller.ExposedCorrelationId);
        }

        [Fact]
        public void ACallerSuppliedCorrelationIdIsIgnored()
        {
            // Caller-supplied text written verbatim into every log line for a request is
            // log injection, and lets two unrelated requests be made to look like one.
            // Same principle as acting identity (ADR-0011): never authority.
            var http = new DefaultHttpContext();
            http.Request.Headers["X-Correlation-Id"] = "attacker-chosen\nFAKE LOG LINE";

            var assigned = PlatformCorrelation.For(http);

            Assert.NotEqual("attacker-chosen\nFAKE LOG LINE", assigned);
            Assert.DoesNotContain('\n', assigned);
            Assert.All(assigned, character => Assert.Contains(character, "0123456789abcdef"));
        }
    }
}
