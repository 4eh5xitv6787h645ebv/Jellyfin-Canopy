using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Security.Claims;
using System.Threading.Tasks;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Helpers;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Querying;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Abstractions;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.ModelBinding;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Services
{
    public sealed class PostPaginationFilterContractTests
    {
        [Theory]
        [InlineData(40, 20)] // fully blocked first page
        [InlineData(40, 10)] // alternating blocked/allowed page
        [InlineData(40, 1)]  // last-page removal
        [InlineData(40, 0)]  // no policy removal
        public void NavigationTotal_IsStableAcrossEveryPageLocalRemoval(int upstreamTotal, int removedFromPage)
        {
            Assert.Equal(
                upstreamTotal,
                PostPaginationFilterContract.NavigationTotal(upstreamTotal, removedFromPage));
        }

        [Fact]
        public void MalformedNegativeUpstreamTotal_DoesNotFaultThePrivacyFilter()
        {
            Assert.Equal(0, PostPaginationFilterContract.NavigationTotal(-1, 1));
        }

        [Fact]
        public void ConcurrentPages_HaveNoSharedCursorOrFirstRequestState()
        {
            var totals = new ConcurrentBag<int>();

            Parallel.For(0, 128, page =>
                totals.Add(PostPaginationFilterContract.NavigationTotal(40, page % 21)));

            Assert.Equal(128, totals.Count);
            Assert.All(totals, total => Assert.Equal(40, total));
            Assert.Single(totals.Distinct());
        }

        [Fact]
        public void QueryResult_RemovesBlockedRows_ButPreservesNextPageReachability()
        {
            var hiddenId = Guid.NewGuid();
            var visibleId = Guid.NewGuid();
            var policy = EnabledLibraryPolicy();
            policy.Items["hidden"] = new HiddenContentItem
            {
                ItemId = hiddenId.ToString("N"),
                Type = "Movie",
                HideScope = "global",
            };
            var filter = NewFilter();
            var page = new QueryResult<BaseItemDto>(
                0,
                40,
                new List<BaseItemDto>
                {
                    new() { Id = hiddenId },
                    new() { Id = visibleId },
                });

            var result = filter.FilterQueryResultForTest(page, policy);

            var kept = Assert.Single(result.Items);
            Assert.Equal(visibleId, kept.Id);
            Assert.Equal(40, result.TotalRecordCount);
            Assert.Equal(0, result.StartIndex);
        }

        [Fact]
        public async Task RealItemsActionFilter_EmptyBlockedFirstPageStillNavigatesToAllowedSecondPage()
        {
            var userId = Guid.NewGuid();
            var blockedIds = Enumerable.Range(0, 20).Select(_ => Guid.NewGuid()).ToArray();
            var allowedIds = Enumerable.Range(0, 20).Select(_ => Guid.NewGuid()).ToArray();
            var policy = EnabledLibraryPolicy();
            foreach (var id in blockedIds)
            {
                policy.Items[id.ToString("N")] = new HiddenContentItem
                {
                    ItemId = id.ToString("N"),
                    Type = "Movie",
                    HideScope = "global",
                };
            }

            var firstContext = NewActionContext(userId, "Items", "GetItems");
            HiddenContentResponseFilter.SeedRequestPolicyForTest(firstContext.HttpContext, policy);
            var firstPage = new QueryResult<BaseItemDto>(
                0,
                40,
                blockedIds.Select(id => new BaseItemDto { Id = id }).ToList());
            var firstResult = await RunRealActionFilter(firstContext, firstPage);

            Assert.Empty(firstResult.Items);
            Assert.Equal(40, firstResult.TotalRecordCount);
            Assert.Equal(
                PostPaginationFilterContract.ContractName,
                firstContext.HttpContext.Response.Headers[PostPaginationFilterContract.HeaderName].ToString());
            Assert.Equal("false", firstContext.HttpContext.Response.Headers[PostPaginationFilterContract.ExactHeaderName].ToString());
            Assert.Equal("20", firstContext.HttpContext.Response.Headers[PostPaginationFilterContract.RemovedHeaderName].ToString());

            var secondContext = NewActionContext(userId, "Items", "GetItems");
            HiddenContentResponseFilter.SeedRequestPolicyForTest(secondContext.HttpContext, policy);
            var secondPage = new QueryResult<BaseItemDto>(
                20,
                40,
                allowedIds.Select(id => new BaseItemDto { Id = id }).ToList());
            var secondResult = await RunRealActionFilter(secondContext, secondPage);

            Assert.Equal(allowedIds, secondResult.Items.Select(item => item.Id));
            Assert.Equal(40, secondResult.TotalRecordCount);
            Assert.Equal(20, secondResult.StartIndex);
            Assert.Equal(
                PostPaginationFilterContract.ContractName,
                secondContext.HttpContext.Response.Headers[PostPaginationFilterContract.HeaderName].ToString());
            Assert.Equal("false", secondContext.HttpContext.Response.Headers[PostPaginationFilterContract.ExactHeaderName].ToString());
            Assert.Equal("0", secondContext.HttpContext.Response.Headers[PostPaginationFilterContract.RemovedHeaderName].ToString());
        }

        [Fact]
        public void ResponseAndJsonShapes_ExposeTheSameIncompleteUpperBoundContract()
        {
            var response = new DefaultHttpContext().Response;
            var json = JsonNode.Parse(
                """{"results":[],"pageInfo":{"page":1,"pages":2,"results":40}}""")!.AsObject();

            PostPaginationFilterContract.MarkResponse(response, 20);
            PostPaginationFilterContract.MarkJson(json, 20);

            Assert.Equal(
                PostPaginationFilterContract.ContractName,
                response.Headers[PostPaginationFilterContract.HeaderName].ToString());
            Assert.Equal("false", response.Headers[PostPaginationFilterContract.ExactHeaderName].ToString());
            Assert.Equal("20", response.Headers[PostPaginationFilterContract.RemovedHeaderName].ToString());
            var contract = Assert.IsType<JsonObject>(json[PostPaginationFilterContract.JsonPropertyName]);
            Assert.Equal(PostPaginationFilterContract.ContractName, (string)contract["contract"]!);
            Assert.False((bool)contract["totalExact"]!);
            Assert.Equal(20, (int)contract["removedFromPage"]!);
            Assert.Equal(40, (int)json["pageInfo"]!["results"]!);
            Assert.Equal(2, (int)json["pageInfo"]!["pages"]!);

            var cleanPage = JsonNode.Parse(
                """{"results":[{"id":1}],"pageInfo":{"page":2,"pages":2,"results":40}}""")!.AsObject();
            PostPaginationFilterContract.MarkJson(cleanPage, 0);
            var cleanContract = Assert.IsType<JsonObject>(cleanPage[PostPaginationFilterContract.JsonPropertyName]);
            Assert.False((bool)cleanContract["totalExact"]!);
            Assert.Equal(0, (int)cleanContract["removedFromPage"]!);
        }

        private static HiddenContentResponseFilter NewFilter()
        {
            var library = new CountingLibraryManager();
            var hierarchy = new HiddenContentHierarchyResolver(library, new StubUserManager(Array.Empty<User>()));
            return new HiddenContentResponseFilter(
                configManager: null!,
                NullLogger<HiddenContentResponseFilter>.Instance,
                new FakePluginConfigProvider(new PluginConfiguration()),
                hierarchy);
        }

        private static ActionContext NewActionContext(Guid userId, string controller, string action)
        {
            var httpContext = new DefaultHttpContext
            {
                User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", userId.ToString()) },
                    "TestAuth")),
            };
            var routeData = new RouteData();
            routeData.Values["controller"] = controller;
            routeData.Values["action"] = action;
            return new ActionContext(
                httpContext,
                routeData,
                new ActionDescriptor(),
                new ModelStateDictionary());
        }

        private static async Task<QueryResult<BaseItemDto>> RunRealActionFilter(
            ActionContext actionContext,
            QueryResult<BaseItemDto> upstreamPage)
        {
            var filters = new List<IFilterMetadata>();
            var controller = new object();
            var executing = new ActionExecutingContext(
                actionContext,
                filters,
                new Dictionary<string, object?>(),
                controller);
            var config = new PluginConfiguration { HiddenContentEnabled = true };
            var library = new CountingLibraryManager();
            var filter = new HiddenContentResponseFilter(
                configManager: null!,
                NullLogger<HiddenContentResponseFilter>.Instance,
                new FakePluginConfigProvider(config),
                new HiddenContentHierarchyResolver(library, new StubUserManager(Array.Empty<User>())));

            var executed = new ActionExecutedContext(actionContext, filters, controller)
            {
                Result = new ObjectResult(upstreamPage),
            };
            await filter.OnActionExecutionAsync(executing, () => Task.FromResult(executed));

            var result = Assert.IsType<ObjectResult>(executed.Result);
            return Assert.IsType<QueryResult<BaseItemDto>>(result.Value);
        }

        private static UserHiddenContent EnabledLibraryPolicy()
            => new()
            {
                Settings = new HiddenContentSettings
                {
                    Enabled = true,
                    FilterLibrary = true,
                },
            };
    }
}
