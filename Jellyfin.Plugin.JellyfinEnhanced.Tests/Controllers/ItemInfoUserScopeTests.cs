using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinEnhanced.Data;
using Xunit;

namespace Jellyfin.Plugin.JellyfinEnhanced.Tests.Controllers
{
    /// <summary>
    /// CSCTRL-4: the ItemInfo metadata endpoints (studio/boxset/person/genre) and the
    /// items/by-providers lookup must resolve items in the caller's user scope so a
    /// non-admin can't read metadata / confirm existence for libraries they can't access.
    /// </summary>
    public class ItemInfoUserScopeTests
    {
        [Fact]
        public void BuildProviderQuery_WithUser_ScopesQueryToThatUser()
        {
            var user = new User("scoped", "Prov", "PwProv");
            var providers = new Dictionary<string, string> { ["Tmdb"] = "603" };

            var query = ItemLookupService.BuildProviderQuery(providers, user);

            // With User set, the core query only returns items in the caller's libraries.
            Assert.Same(user, query.User);
        }

        [Fact]
        public void BuildProviderQuery_WithoutUser_LeavesQueryUnscoped()
        {
            var providers = new Dictionary<string, string> { ["Tmdb"] = "603" };

            var query = ItemLookupService.BuildProviderQuery(providers);

            // Null user preserves the former unscoped (server-side) behavior.
            Assert.Null(query.User);
        }

        // A non-generic _libraryManager.GetItemById(...) call has NO user argument and
        // therefore reads across every library. The user-scoped overload is the generic
        // GetItemById<BaseItem>(id, user), which this regex deliberately does NOT match.
        private static readonly Regex UnscopedGetItemById = new(
            @"GetItemById\(", RegexOptions.Compiled);

        [Fact]
        public void ItemInfoController_HasNoUnscopedGetItemByIdCalls()
        {
            var source = File.ReadAllText(ItemInfoControllerPath());

            var offenders = source
                .Split('\n')
                .Select((line, i) => (line, number: i + 1))
                .Where(x => UnscopedGetItemById.IsMatch(x.line))
                .Select(x => $"{x.number}: {x.line.Trim()}")
                .ToList();

            Assert.True(
                offenders.Count == 0,
                "Unscoped GetItemById(...) call(s) in ItemInfoController — a metadata endpoint "
                + "reads across libraries the caller can't access. Use the user-scoped "
                + "GetItemById<BaseItem>(id, user) overload:\n" + string.Join("\n", offenders));
        }

        [Fact]
        public void ItemInfoController_ProviderLookup_PassesCallerUser()
        {
            var source = File.ReadAllText(ItemInfoControllerPath());

            // The items/by-providers endpoint must forward the caller so the lookup is scoped.
            Assert.Contains("GetItemIdsByProviders(providers, GetCallerUser())", source);
        }

        private static string ItemInfoControllerPath([CallerFilePath] string sourceFile = "")
            => Path.GetFullPath(Path.Combine(
                Path.GetDirectoryName(sourceFile)!, "..", "..",
                "Jellyfin.Plugin.JellyfinEnhanced", "Controllers", "ItemInfoController.cs"));
    }
}
