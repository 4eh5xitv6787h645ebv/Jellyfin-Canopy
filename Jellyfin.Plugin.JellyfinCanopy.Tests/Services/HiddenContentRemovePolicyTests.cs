using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Claims;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Services;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
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
    public sealed class HiddenContentRemovePolicyTests : IDisposable
    {
        private readonly string _baseDir;
        private readonly UserConfigurationManager _manager;
        private readonly RemoveFromHomePolicyService _policy;
        private readonly HashSet<string> _userIds = new(StringComparer.Ordinal);

        public HiddenContentRemovePolicyTests()
        {
            _baseDir = Path.Combine(
                Path.GetTempPath(),
                "jc-remove-policy-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_baseDir);
            _manager = new UserConfigurationManager(
                new StubAppPaths(_baseDir),
                NullLogger<UserConfigurationManager>.Instance);
            _policy = new RemoveFromHomePolicyService(
                _manager,
                NullLogger<RemoveFromHomePolicyService>.Instance);
        }

        public void Dispose()
        {
            foreach (var userId in _userIds)
            {
                HiddenContentResponseFilter.InvalidateUser(userId);
                _policy.Invalidate(userId);
            }
            try { Directory.Delete(_baseDir, recursive: true); } catch { /* best effort */ }
        }

        public static IEnumerable<object[]> EffectivePolicyCases()
        {
            foreach (var administratorDefault in new[] { false, true })
            {
                foreach (var userOverride in new[] { false, true })
                {
                    yield return new object[]
                    {
                        administratorDefault,
                        userOverride,
                        "Items",
                        "GetResumeItems",
                    };
                    yield return new object[]
                    {
                        administratorDefault,
                        userOverride,
                        "TvShows",
                        "GetNextUp",
                    };
                }
            }
        }

        [Theory]
        [MemberData(nameof(EffectivePolicyCases))]
        public async Task AuthenticatedUserSetting_OwnsBothRemoveSurfaces(
            bool administratorDefault,
            bool userOverride,
            string controller,
            string action)
        {
            var userId = Guid.NewGuid();
            var hiddenItem = Guid.NewGuid();
            SaveHiddenItem(userId, hiddenItem);
            _manager.SaveUserConfiguration(
                userId.ToString("N"),
                "settings.json",
                new UserSettings { RemoveContinueWatchingEnabled = userOverride });

            var hidden = await RunFilter(
                userId,
                hiddenItem,
                controller,
                action,
                new PluginConfiguration
                {
                    HiddenContentEnabled = false,
                    RemoveContinueWatchingEnabled = administratorDefault,
                });

            Assert.Equal(userOverride, hidden);
        }

        [Fact]
        public async Task SimultaneousUsers_DoNotShareEffectivePolicy()
        {
            var enabledUser = Guid.NewGuid();
            var disabledUser = Guid.NewGuid();
            var enabledItem = Guid.NewGuid();
            var disabledItem = Guid.NewGuid();
            SaveHiddenItem(enabledUser, enabledItem);
            SaveHiddenItem(disabledUser, disabledItem);
            _manager.SaveUserConfiguration(
                enabledUser.ToString("N"),
                "settings.json",
                new UserSettings { RemoveContinueWatchingEnabled = true });
            _manager.SaveUserConfiguration(
                disabledUser.ToString("N"),
                "settings.json",
                new UserSettings { RemoveContinueWatchingEnabled = false });
            var config = new PluginConfiguration
            {
                HiddenContentEnabled = false,
                RemoveContinueWatchingEnabled = true,
            };

            var results = await Task.WhenAll(
                RunFilter(enabledUser, enabledItem, "Items", "GetResumeItems", config),
                RunFilter(disabledUser, disabledItem, "Items", "GetResumeItems", config));

            Assert.True(results[0]);
            Assert.False(results[1]);
        }

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public async Task MissingSettings_UsesAdministratorDefaultWithoutCreatingAFile(bool administratorDefault)
        {
            var userId = Guid.NewGuid();
            var hiddenItem = Guid.NewGuid();
            SaveHiddenItem(userId, hiddenItem);
            var settingsPath = PathFor(userId, "settings.json");

            var hidden = await RunFilter(
                userId,
                hiddenItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration
                {
                    HiddenContentEnabled = false,
                    RemoveContinueWatchingEnabled = administratorDefault,
                });

            Assert.Equal(administratorDefault, hidden);
            Assert.False(File.Exists(settingsPath));
        }

        [Fact]
        public async Task MissingSettings_TracksTheLiveAdministratorDefaultWithoutBecomingAnOverride()
        {
            var userId = Guid.NewGuid();
            var hiddenItem = Guid.NewGuid();
            SaveHiddenItem(userId, hiddenItem);

            Assert.True(await RunFilter(
                userId,
                hiddenItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration
                {
                    HiddenContentEnabled = false,
                    RemoveContinueWatchingEnabled = true,
                }));
            Assert.False(await RunFilter(
                userId,
                hiddenItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration
                {
                    HiddenContentEnabled = false,
                    RemoveContinueWatchingEnabled = false,
                }));
        }

        [Fact]
        public async Task CorruptSettings_ColdStartFailsClosed_ThenRetainsLastKnownGoodAndInvalidatesOnRepair()
        {
            var coldUser = Guid.NewGuid();
            var coldItem = Guid.NewGuid();
            SaveHiddenItem(coldUser, coldItem);
            File.WriteAllText(PathFor(coldUser, "settings.json"), "{ not valid json ]");
            _policy.Invalidate(coldUser.ToString("N"));

            Assert.True(await RunFilter(
                coldUser,
                coldItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration { HiddenContentEnabled = false }));

            var retainedUser = Guid.NewGuid();
            var retainedItem = Guid.NewGuid();
            SaveHiddenItem(retainedUser, retainedItem);
            _manager.SaveUserConfiguration(
                retainedUser.ToString("N"),
                "settings.json",
                new UserSettings { RemoveContinueWatchingEnabled = false });
            Assert.False(await RunFilter(
                retainedUser,
                retainedItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration { HiddenContentEnabled = false }));

            File.WriteAllText(PathFor(retainedUser, "settings.json"), "{ not valid json ]");
            _policy.ExpireCacheForTest(retainedUser.ToString("N"));
            Assert.False(await RunFilter(
                retainedUser,
                retainedItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration { HiddenContentEnabled = false }));

            _manager.SaveUserConfiguration(
                retainedUser.ToString("N"),
                "settings.json",
                new UserSettings { RemoveContinueWatchingEnabled = true });
            _policy.Invalidate(retainedUser.ToString("N"));
            Assert.True(await RunFilter(
                retainedUser,
                retainedItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration { HiddenContentEnabled = false }));
        }

        [Fact]
        public async Task AnonymousRequest_BypassesPolicyBeforeAnyUserStoreAccess()
        {
            var hiddenItem = Guid.NewGuid();
            var pluginStore = Path.Combine(
                _baseDir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy");

            var hidden = await RunFilter(
                null,
                hiddenItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration
                {
                    HiddenContentEnabled = false,
                    RemoveContinueWatchingEnabled = true,
                });

            Assert.False(hidden);
            Assert.True(Directory.Exists(pluginStore));
            Assert.Empty(Directory.EnumerateDirectories(pluginStore));
        }

        [Fact]
        public async Task HiddenContentMasterSwitch_RemainsIndependentOfUserRemoveSetting()
        {
            var userId = Guid.NewGuid();
            var hiddenItem = Guid.NewGuid();
            SaveHiddenItem(userId, hiddenItem);
            _manager.SaveUserConfiguration(
                userId.ToString("N"),
                "settings.json",
                new UserSettings { RemoveContinueWatchingEnabled = false });

            Assert.True(await RunFilter(
                userId,
                hiddenItem,
                "Items",
                "GetResumeItems",
                new PluginConfiguration
                {
                    HiddenContentEnabled = true,
                    RemoveContinueWatchingEnabled = false,
                }));
        }

        [Fact]
        public void EffectivePolicyCache_IsHardBounded()
        {
            Assert.Equal(2_048, _policy.MaximumEntriesForTest);
            Assert.Equal(2_048, _policy.MaximumWeightForTest);
        }

        [Fact]
        public void EffectivePolicyInvalidation_CanonicalizesDashedUserIds()
        {
            var userId = Guid.NewGuid();
            _policy.SeedCacheForTest(userId.ToString("N"), enabled: true);

            _policy.Invalidate(userId.ToString("D"));

            Assert.False(_policy.IsCachedForTest(userId.ToString("N")));
        }

        private void SaveHiddenItem(Guid userId, Guid itemId)
        {
            _userIds.Add(userId.ToString("N"));
            var policy = new UserHiddenContent();
            policy.Items[itemId.ToString("N")] = new HiddenContentItem
            {
                ItemId = itemId.ToString("N"),
                Type = "Movie",
                HideScope = "homesections",
            };
            _manager.SaveUserConfiguration(userId.ToString("N"), "hidden-content.json", policy);
            HiddenContentResponseFilter.InvalidateUser(userId.ToString("N"));
            _policy.Invalidate(userId.ToString("N"));
        }

        private string PathFor(Guid userId, string fileName)
            => Path.Combine(
                _baseDir,
                "configurations",
                "Jellyfin.Plugin.JellyfinCanopy",
                userId.ToString("N"),
                fileName);

        private async Task<bool> RunFilter(
            Guid? userId,
            Guid itemId,
            string controller,
            string action,
            PluginConfiguration configuration)
        {
            var httpContext = new DefaultHttpContext();
            if (userId.HasValue)
            {
                httpContext.User = new ClaimsPrincipal(new ClaimsIdentity(
                    new[] { new Claim("Jellyfin-UserId", userId.Value.ToString()) },
                    "TestAuth"));
            }

            var routeData = new RouteData();
            routeData.Values["controller"] = controller;
            routeData.Values["action"] = action;
            var actionContext = new ActionContext(
                httpContext,
                routeData,
                new ActionDescriptor(),
                new ModelStateDictionary());
            var filters = new List<IFilterMetadata>();
            var controllerInstance = new object();
            var executing = new ActionExecutingContext(
                actionContext,
                filters,
                new Dictionary<string, object?>(),
                controllerInstance);
            var upstream = new QueryResult<BaseItemDto>(
                0,
                1,
                new List<BaseItemDto> { new() { Id = itemId } });
            var executed = new ActionExecutedContext(actionContext, filters, controllerInstance)
            {
                Result = new ObjectResult(upstream),
            };
            var hierarchy = new HiddenContentHierarchyResolver(
                new CountingLibraryManager(),
                new StubUserManager(Array.Empty<User>()));
            var filter = new HiddenContentResponseFilter(
                _manager,
                NullLogger<HiddenContentResponseFilter>.Instance,
                new FakePluginConfigProvider(configuration),
                _policy,
                hierarchy);

            await filter.OnActionExecutionAsync(executing, () => Task.FromResult(executed));

            var result = Assert.IsType<ObjectResult>(executed.Result);
            var page = Assert.IsType<QueryResult<BaseItemDto>>(result.Value);
            return page.Items.Count == 0;
        }
    }
}
