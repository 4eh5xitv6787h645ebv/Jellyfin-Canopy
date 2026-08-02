using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin;
using Jellyfin.Plugin.JellyfinCanopy.Tests.TestDoubles;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Querying;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    public class JellyfinPlatformHostItemAccessTests
    {
        private static User NewUser(string name, bool administrator = false)
        {
            var user = new User(name, "provider", "resetProvider");
            user.SetPermission(PermissionKind.IsAdministrator, administrator);
            return user;
        }

        private static JellyfinPlatformHost Host(
            Func<Guid, User?> findUser,
            CountingLibraryManager libraryManager,
            Func<Guid, BaseItem?>? findItem = null) => new(
                findUser,
                Array.Empty<User>,
                findItem ?? (_ => null),
                (userId, itemId) => JellyfinPlatformHost.FindAccessibleItem(
                    findUser,
                    libraryManager,
                    userId,
                    itemId),
                Array.Empty<SessionInfo>,
                Array.Empty<LocalPlugin>);

        [Theory]
        [InlineData(false)]
        [InlineData(true)]
        public void AccessibleItemUsesOneCurrentUserScopedSafeOrderQuery(bool administrator)
        {
            var user = NewUser(administrator ? "admin" : "viewer", administrator);
            var item = new Movie
            {
                Id = Guid.NewGuid(),
                Name = "Server title",
                Path = "/private/server/path.mkv",
                ParentId = Guid.NewGuid(),
                ProviderIds = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["tmDB"] = "603",
                    ["Tvdb"] = "123",
                    ["IMDB"] = "tt0133093",
                    ["CustomProvider"] = "must-not-cross",
                },
            };
            var configuredBeforeIds = false;
            var restrictedTopParentId = Guid.NewGuid();
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (query, configuredUser) =>
                {
                    configuredBeforeIds = query.ItemIds.Length == 0
                        && ReferenceEquals(user, configuredUser);
                    Assert.Equal(
                        administrator,
                        configuredUser.HasPermission(PermissionKind.IsAdministrator));
                    query.TopParentIds = administrator
                        ? Array.Empty<Guid>()
                        : new[] { restrictedTopParentId };
                },
                GetItemListHook = query =>
                {
                    Assert.True(configuredBeforeIds);
                    Assert.Same(user, query.User);
                    Assert.Equal(new[] { item.Id }, query.ItemIds);
                    Assert.Equal(
                        administrator ? Array.Empty<Guid>() : new[] { restrictedTopParentId },
                        query.TopParentIds);
                    Assert.Equal(2, query.Limit);
                    Assert.Contains(ItemFields.ProviderIds, query.DtoOptions.Fields);
                    return new BaseItem[] { item };
                },
            };

            var result = Host(id => id == user.Id ? user : null, library)
                .Library.FindAccessible(user.Id, item.Id);

            Assert.True(result.IsAccessible);
            var projection = Assert.IsType<HostAccessibleItem>(result.Item);
            Assert.Equal(item.Id, projection.Id);
            Assert.Equal(HostItemKind.Movie, projection.Kind);
            Assert.Null(projection.SeriesId);
            Assert.Equal(
                new[]
                {
                    new HostProviderReference("Tmdb", "603"),
                    new HostProviderReference("Tvdb", "123"),
                    new HostProviderReference("Imdb", "tt0133093"),
                },
                projection.ProviderReferences);
            Assert.Equal(1, library.GetItemListCallCount);
            Assert.Equal(0, library.GetItemByIdCallCount);
            Assert.Equal(0, library.GetItemByIdUserCallCount);
        }

        [Fact]
        public void RestrictedUserPolicyAndLibraryScopeReachTheAuthoritativeQueryBeforeDenial()
        {
            var user = NewUser("restricted-policy-viewer");
            user.MaxParentalRatingScore = 13;
            user.MaxParentalRatingSubScore = 1;
            user.SetPreference(PreferenceKind.BlockUnratedItems, new[] { UnratedItem.Movie });
            user.SetPreference(PreferenceKind.BlockedTags, new[] { "Violence" });
            user.SetPreference(PreferenceKind.AllowedTags, new[] { "Family" });
            user.SetPermission(PermissionKind.EnableAllFolders, false);
            var allowedLibraryId = Guid.NewGuid();
            user.SetPreference(PreferenceKind.EnabledFolders, new[] { allowedLibraryId });
            var requestedItemId = Guid.NewGuid();
            var configuredBeforeIds = false;
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (query, configuredUser) =>
                {
                    configuredBeforeIds = query.ItemIds.Length == 0;
                    Assert.Same(user, configuredUser);
                    Assert.False(configuredUser.HasPermission(PermissionKind.EnableAllFolders));
                    Assert.Equal(new[] { allowedLibraryId }, configuredUser.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders));
                    query.TopParentIds = new[] { allowedLibraryId };
                },
                GetItemListHook = query =>
                {
                    Assert.True(configuredBeforeIds);
                    Assert.Same(user, query.User);
                    Assert.Equal(new[] { requestedItemId }, query.ItemIds);
                    Assert.Equal(new[] { allowedLibraryId }, query.TopParentIds);
                    Assert.Equal(13, query.MaxParentalRating!.Score);
                    Assert.Equal(1, query.MaxParentalRating.SubScore);
                    Assert.Equal(new[] { UnratedItem.Movie }, query.BlockUnratedItems);
                    Assert.Equal(new[] { "violence" }, query.ExcludeInheritedTags);
                    Assert.Equal(new[] { "family" }, query.IncludeInheritedTags);
                    return Array.Empty<BaseItem>();
                },
            };

            var result = Host(_ => user, library)
                .Library.FindAccessible(user.Id, requestedItemId);

            Assert.Equal(HostItemAccessResult.NotAccessible, result);
            Assert.False(result.IsAccessible);
            Assert.Null(result.Item);
            Assert.Equal(1, library.GetItemListCallCount);
            Assert.Equal(0, library.GetItemByIdCallCount);
        }

        [Fact]
        public void UserDeletedAfterActorResolutionIsDeniedBeforeAnyLibraryRead()
        {
            var user = NewUser("deleted-user");
            User? current = user;
            var library = new CountingLibraryManager();
            var host = Host(_ => current, library);

            Assert.True(host.Users.Find(user.Id).HasValue);
            current = null;

            var result = host.Library.FindAccessible(user.Id, Guid.NewGuid());

            Assert.Equal(HostItemAccessResult.NotAccessible, result);
            Assert.False(result.IsAccessible);
            Assert.Null(result.Item);
            Assert.Equal(0, library.GetItemListCallCount);
            Assert.Equal(0, library.GetItemByIdCallCount);
        }

        [Theory]
        [InlineData("missing")]
        [InlineData("deleted")]
        [InlineData("inaccessible")]
        [InlineData("parental-blocked")]
        [InlineData("library-excluded")]
        public void EveryHostDenialHasTheSameNonDistinguishableResult(string condition)
        {
            var user = NewUser("restricted-viewer");
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (query, configuredUser) =>
                {
                    Assert.Same(user, configuredUser);
                    query.TopParentIds = new[] { Guid.NewGuid() };
                },
                GetItemListHook = _ => Array.Empty<BaseItem>(),
            };

            var result = Host(_ => user, library)
                .Library.FindAccessible(user.Id, Guid.NewGuid());

            Assert.Equal(HostItemAccessResult.NotAccessible, result);
            Assert.False(result.IsAccessible, condition);
            Assert.Null(result.Item);
        }

        [Fact]
        public void WrongOrIncompleteCandidateSetNeverAuthorizesATruncatedPrefix()
        {
            var user = NewUser("bounded-viewer");
            var requested = new Movie { Id = Guid.NewGuid() };
            var other = new Movie { Id = Guid.NewGuid() };
            var responses = new Queue<IReadOnlyList<BaseItem>>(new[]
            {
                new BaseItem[] { other },
                new BaseItem[] { requested, other },
            });
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (_, _) => { },
                GetItemListHook = query =>
                {
                    Assert.Equal(2, query.Limit);
                    return responses.Dequeue();
                },
            };
            var host = Host(_ => user, library);

            Assert.Equal(
                HostItemAccessResult.NotAccessible,
                host.Library.FindAccessible(user.Id, requested.Id));
            Assert.Equal(
                HostItemAccessResult.NotAccessible,
                host.Library.FindAccessible(user.Id, requested.Id));
            Assert.Empty(responses);
        }

        [Fact]
        public void SeriesAncestryIsServerDerivedAndArbitraryParentDoesNotCrossTheSeam()
        {
            var user = NewUser("episode-viewer");
            var seriesId = Guid.NewGuid();
            var episode = new Episode
            {
                Id = Guid.NewGuid(),
                SeriesId = seriesId,
                ParentId = Guid.NewGuid(),
            };
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (_, _) => { },
                GetItemListHook = _ => new BaseItem[] { episode },
            };

            var result = Host(_ => user, library)
                .Library.FindAccessible(user.Id, episode.Id);

            Assert.Equal(HostItemKind.Episode, result.Item!.Value.Kind);
            Assert.Equal(seriesId, result.Item.Value.SeriesId);
            Assert.DoesNotContain(
                result.Item.Value.GetType().GetProperties(),
                property => property.Name == "ParentId");
        }

        [Fact]
        public void MalformedAmbiguousAndOverBoundProviderReferencesAreDropped()
        {
            var user = NewUser("provider-viewer");
            var item = new Series
            {
                Id = Guid.NewGuid(),
                ProviderIds = new Dictionary<string, string>(StringComparer.Ordinal)
                {
                    ["Tmdb"] = "603",
                    ["tmdb"] = "604",
                    ["Tvdb"] = new string('7', 129),
                    ["Imdb"] = "tt01\n33093",
                },
            };
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (_, _) => { },
                GetItemListHook = _ => new BaseItem[] { item },
            };

            var result = Host(_ => user, library)
                .Library.FindAccessible(user.Id, item.Id);

            Assert.True(result.IsAccessible);
            Assert.Empty(result.Item!.Value.ProviderReferences);
        }

        [Fact]
        public void OverBoundServerProviderInventoryPublishesNoPrefix()
        {
            var user = NewUser("many-provider-viewer");
            var providers = Enumerable.Range(0, 33)
                .ToDictionary(index => "Provider" + index, _ => "value", StringComparer.Ordinal);
            providers["Tmdb"] = "603";
            var item = new Movie { Id = Guid.NewGuid(), ProviderIds = providers };
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (_, _) => { },
                GetItemListHook = _ => new BaseItem[] { item },
            };

            var result = Host(_ => user, library)
                .Library.FindAccessible(user.Id, item.Id);

            Assert.True(result.IsAccessible);
            Assert.Empty(result.Item!.Value.ProviderReferences);
        }

        [Fact]
        public void AccessibleLookupNeverComposesWithTheLegacyUnscopedFind()
        {
            var user = NewUser("safe-viewer");
            var item = new Movie { Id = Guid.NewGuid() };
            var library = new CountingLibraryManager
            {
                ConfigureUserAccessHook = (_, _) => { },
                GetItemListHook = _ => new BaseItem[] { item },
            };
            var host = Host(
                _ => user,
                library,
                _ => throw new InvalidOperationException("Unscoped find must not run"));

            var result = host.Library.FindAccessible(user.Id, item.Id);

            Assert.True(result.IsAccessible);
            Assert.Equal(item.Id, result.Item!.Value.Id);
            Assert.Equal(0, library.GetItemByIdCallCount);
        }
    }
}
