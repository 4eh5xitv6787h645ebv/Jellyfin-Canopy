using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting.Jellyfin;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Plugins;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// The adapter's translations, which is where its defects would actually live — an
    /// id that should have become <c>null</c>, a status read from the wrong place, a
    /// missing parent that throws instead of returning nothing.
    ///
    /// Driven through the internal delegate seam because Jellyfin's manager interfaces
    /// are far too large to implement in a test. That is the reason the seam exists.
    /// </summary>
    public class JellyfinPlatformHostTests
    {
        private static User NewUser(string name) => new(name, "provider", "resetProvider");

        private static LocalPlugin NewPlugin(string name, PluginStatus status) => new(
            "/plugins/" + name,
            true,
            new PluginManifest
            {
                Id = Guid.NewGuid(),
                Name = name,
                Version = "1.2.3",
                Status = status,
            });

        private static JellyfinPlatformHost Host(
            Func<Guid, User?>? findUser = null,
            Func<IEnumerable<User>>? allUsers = null,
            Func<Guid, BaseItem?>? findItem = null,
            Func<IEnumerable<SessionInfo>>? sessions = null,
            Func<IEnumerable<LocalPlugin>>? plugins = null) => new(
                findUser ?? (_ => null),
                allUsers ?? Array.Empty<User>,
                findItem ?? (_ => null),
                sessions ?? Array.Empty<SessionInfo>,
                plugins ?? Array.Empty<LocalPlugin>);

        [Fact]
        public void AMissingUserIsNullRatherThanAnException()
        {
            // A user disappearing between authentication and use is ordinary - deletion,
            // a stale token - so it is a return value, not an exceptional case.
            Assert.Null(Host().Users.Find(Guid.NewGuid()));
        }

        [Fact]
        public void AUserIsMappedToTheKernelsOwnType()
        {
            var user = NewUser("ada");
            var host = Host(findUser: _ => user);

            var mapped = host.Users.Find(user.Id);

            Assert.NotNull(mapped);
            Assert.Equal(user.Id, mapped!.Value.Id);
            Assert.Equal("ada", mapped.Value.Name);

            // A freshly constructed user holds no administrator permission, and the
            // adapter must report exactly what the host says rather than guessing.
            Assert.False(mapped.Value.IsAdministrator);
        }

        [Fact]
        public void AllUsersAreEnumerated()
        {
            var host = Host(allUsers: () => new[] { NewUser("ada"), NewUser("grace") });

            Assert.Equal(new[] { "ada", "grace" }, host.Users.All().Select(user => user.Name));
        }

        [Fact]
        public void AMissingItemIsNull()
        {
            Assert.Null(Host().Library.Find(Guid.NewGuid()));
        }

        [Fact]
        public void AnItemCarriesItsHostTypeNameAsItsKind()
        {
            // The kernel must be able to tell a Series from an Episode without importing
            // Jellyfin's entity hierarchy, so the host's own type name crosses as a string.
            var folder = new Folder { Id = Guid.NewGuid(), Name = "Season 1" };
            var host = Host(findItem: _ => folder);

            var mapped = host.Library.Find(folder.Id);

            Assert.NotNull(mapped);
            Assert.Equal("Season 1", mapped!.Value.Name);
            Assert.Equal("Folder", mapped.Value.Kind);
        }

        [Fact]
        public void AnItemWithNoParentReportsNullRatherThanTheEmptyGuid()
        {
            // Guid.Empty is a real value that would read as "the item whose id is all
            // zeroes". Leaking it here would make "no parent" indistinguishable from a
            // parent the kernel could try to look up.
            var orphan = new Folder { Id = Guid.NewGuid(), Name = "Top", ParentId = Guid.Empty };

            Assert.Null(Host(findItem: _ => orphan).Library.Find(orphan.Id)!.Value.ParentId);
        }

        [Fact]
        public void AnItemWithAParentReportsIt()
        {
            var parentId = Guid.NewGuid();
            var child = new Folder { Id = Guid.NewGuid(), Name = "Child", ParentId = parentId };

            Assert.Equal(parentId, Host(findItem: _ => child).Library.Find(child.Id)!.Value.ParentId);
        }

        [Fact]
        public void ChildrenOfAMissingOrNonFolderItemIsEmptyRatherThanAFailure()
        {
            // Callers iterate this. They cannot act differently on "no such parent" than
            // on "a parent with no children", so the two collapse deliberately.
            Assert.Empty(Host().Library.ChildrenOf(Guid.NewGuid()));
        }

        [Fact]
        public void ASessionWithNoUserReportsNullRatherThanTheEmptyGuid()
        {
            var session = new SessionInfo(null!, null!) { DeviceId = "tv-1", Client = "AndroidTV" };
            var host = Host(sessions: () => new[] { session });

            var mapped = Assert.Single(host.Sessions.Active());

            Assert.Null(mapped.UserId);
            Assert.Equal("tv-1", mapped.DeviceId);
            Assert.Equal("AndroidTV", mapped.Client);
        }

        [Fact]
        public void SessionsCanBeFilteredToOneUser()
        {
            var mine = Guid.NewGuid();
            var theirs = Guid.NewGuid();
            var sessions = new[]
            {
                new SessionInfo(null!, null!) { UserId = mine, DeviceId = "a" },
                new SessionInfo(null!, null!) { UserId = theirs, DeviceId = "b" },
                new SessionInfo(null!, null!) { UserId = mine, DeviceId = "c" },
            };

            var host = Host(sessions: () => sessions);

            Assert.Equal(new[] { "a", "c" }, host.Sessions.ForUser(mine).Select(session => session.DeviceId));
        }

        [Fact]
        public void APluginsStatusIsReadFromItsManifest()
        {
            // EP-00 (spike-evidence S5): LocalPlugin.Status does not exist - the status
            // lives on the manifest. Reading the wrong one does not compile, and this
            // test keeps the mapping honest if that ever changes.
            var plugin = NewPlugin("Canopy", PluginStatus.Active);
            var host = Host(plugins: () => new[] { plugin });

            var mapped = Assert.Single(host.Plugins.Installed());

            Assert.Equal("Canopy", mapped.Name);
            Assert.Equal("1.2.3", mapped.Version);
            Assert.Equal("Active", mapped.Status);
        }

        [Fact]
        public void ADisabledPluginReportsRestartBecauseNothingIsEverUnloaded()
        {
            // EP-00 (spike-evidence S6): a runtime "disable" produces Restart, not
            // Disabled, because Jellyfin never actually unloads an assembly. A consumer
            // that expected "Disabled" would silently never match.
            var host = Host(plugins: () => new[] { NewPlugin("Canopy", PluginStatus.Restart) });

            Assert.Equal("Restart", Assert.Single(host.Plugins.Installed()).Status);
        }

        [Fact]
        public void APluginCanBeFoundByIdAndIsNullWhenAbsent()
        {
            var plugin = NewPlugin("Canopy", PluginStatus.Active);
            var host = Host(plugins: () => new[] { plugin });

            Assert.Equal("Canopy", host.Plugins.Find(plugin.Id)!.Value.Name);
            Assert.Null(host.Plugins.Find(Guid.NewGuid()));
        }

        [Fact]
        public void TheAdapterIsPureTranslationAndReReadsTheHostEachTime()
        {
            // No caching, deliberately. A cache here would be a second place where
            // behaviour lives, and the extraction this seam protects would stop being a
            // mechanical move.
            var reads = 0;
            var host = Host(allUsers: () =>
            {
                reads++;
                return new[] { NewUser("ada") };
            });

            host.Users.All();
            host.Users.All();

            Assert.Equal(2, reads);
        }
    }
}
