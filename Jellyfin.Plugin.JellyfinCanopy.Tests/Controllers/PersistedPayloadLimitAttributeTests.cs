using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers;

public sealed class PersistedPayloadLimitAttributeTests
{
    [Fact]
    public void EveryBoundedPersistenceEndpoint_UsesItsPreBindingPolicy()
    {
        AssertLimit(
            typeof(UserSettingsController),
            nameof(UserSettingsController.SaveUserSettingsSettings),
            PersistedPayloadPolicy.StandardRequestBytes);
        AssertLimit(
            typeof(UserSettingsController),
            nameof(UserSettingsController.SaveUserSettingsShortcuts),
            PersistedPayloadPolicy.StandardRequestBytes);
        AssertLimit(
            typeof(UserSettingsController),
            nameof(UserSettingsController.SaveUserSettingsElsewhere),
            PersistedPayloadPolicy.StandardRequestBytes);
        AssertLimit(
            typeof(HiddenContentController),
            nameof(HiddenContentController.SaveUserHiddenContent),
            PersistedPayloadPolicy.HiddenContentRequestBytes);
        AssertLimit(
            typeof(ReviewsController),
            nameof(ReviewsController.UpsertReview),
            ReviewLimits.RequestBytes);
        AssertLimit(
            typeof(ReviewsController),
            nameof(ReviewsController.AdminUpsertReview),
            ReviewLimits.RequestBytes);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExactBoundary_ReachesModelBindingForDeclaredAndChunkedBodies(bool declaredLength)
    {
        const int limit = 1024;
        var bytes = Enumerable.Repeat((byte)'x', limit).ToArray();
        var (context, actionContext, filters) = Context(bytes, declaredLength ? limit : null);
        var called = false;
        var observedBytes = 0;

        await new PersistedPayloadLimitAttribute(limit).OnResourceExecutionAsync(context, async () =>
        {
            called = true;
            using var copy = new MemoryStream();
            await actionContext.HttpContext.Request.Body.CopyToAsync(copy);
            observedBytes = checked((int)copy.Length);
            return new ResourceExecutedContext(actionContext, filters);
        });

        Assert.True(called);
        Assert.Equal(limit, observedBytes);
        Assert.Equal(StatusCodes.Status200OK, actionContext.HttpContext.Response.StatusCode);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task NPlusOne_IsStructured413BeforeModelBinding(bool declaredLength)
    {
        const int limit = 1024;
        var bytes = Enumerable.Repeat((byte)'x', limit + 1).ToArray();
        var (context, actionContext, filters) = Context(bytes, declaredLength ? limit + 1 : null);
        var called = false;

        await new PersistedPayloadLimitAttribute(limit).OnResourceExecutionAsync(context, () =>
        {
            called = true;
            return Task.FromResult(new ResourceExecutedContext(actionContext, filters));
        });

        Assert.False(called);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, actionContext.HttpContext.Response.StatusCode);
        actionContext.HttpContext.Response.Body.Position = 0;
        using var response = await JsonDocument.ParseAsync(actionContext.HttpContext.Response.Body);
        Assert.Equal("payload_too_large", response.RootElement.GetProperty("code").GetString());
        Assert.False(response.RootElement.GetProperty("success").GetBoolean());
        Assert.DoesNotContain(Encoding.UTF8.GetString(bytes), response.RootElement.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task ClientAbortWhileBuffering_DoesNotInvokePipelineOrSurfaceAnError()
    {
        using var aborted = new CancellationTokenSource();
        aborted.Cancel();
        var (context, actionContext, filters) = Context(new byte[16], contentLength: null);
        actionContext.HttpContext.RequestAborted = aborted.Token;
        var called = false;

        await new PersistedPayloadLimitAttribute(1024).OnResourceExecutionAsync(context, () =>
        {
            called = true;
            return Task.FromResult(new ResourceExecutedContext(actionContext, filters));
        });

        Assert.False(called);
    }

    private static (ResourceExecutingContext Context, ActionContext Action, IList<IFilterMetadata> Filters) Context(
        byte[] body,
        long? contentLength)
    {
        var http = new DefaultHttpContext();
        http.Request.Body = new MemoryStream(body, writable: false);
        http.Request.ContentLength = contentLength;
        http.Response.Body = new MemoryStream();
        var action = new ActionContext(
            http,
            new RouteData(),
            new ActionDescriptor(),
            new ModelStateDictionary());
        IList<IFilterMetadata> filters = new List<IFilterMetadata>();
        return (new ResourceExecutingContext(action, filters, new List<IValueProviderFactory>()), action, filters);
    }

    private static void AssertLimit(Type controller, string methodName, long expected)
    {
        var method = controller.GetMethod(methodName) ?? throw new InvalidOperationException(methodName);
        var attribute = Assert.Single(method.GetCustomAttributes(typeof(PersistedPayloadLimitAttribute), inherit: true));
        Assert.Equal(expected, Assert.IsType<PersistedPayloadLimitAttribute>(attribute).MaximumBytes);
    }
}
