using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Platform
{
    /// <summary>
    /// Pins the public surface of Platform v1.
    ///
    /// The pre-platform <c>/JellyfinCanopy/*</c> routes fail OPEN — an endpoint with no
    /// authorization attribute is anonymous, and nothing catches it. Platform v1 fails
    /// closed via <see cref="PlatformControllerBase"/>, and these tests make that a
    /// build-enforced property rather than a convention someone has to remember.
    ///
    /// Same technique as <c>AtomicFileWriteGuardTests</c>: an explicit allowlist, plus
    /// an anti-rot test so the allowlist cannot quietly outlive what it describes.
    /// </summary>
    public class PlatformAnonymousSurfaceTests
    {
        /// <summary>
        /// Every anonymous Platform v1 action, with the reason it is allowed to be one.
        ///
        /// Adding an entry here widens what an unauthenticated caller can reach. That
        /// should be a deliberate, reviewable change — which is the entire point of
        /// listing them.
        /// </summary>
        private static readonly Dictionary<string, string> AllowedAnonymousActions = new(StringComparer.Ordinal)
        {
            [$"{nameof(PlatformDiscoveryController)}.{nameof(PlatformDiscoveryController.GetDiscovery)}"] =
                "A client must be able to learn whether the platform exists before it has a reason to "
                + "authenticate. The payload is availability plus the protocol range and nothing else.",
        };

        private static IEnumerable<Type> PlatformControllers => typeof(PlatformControllerBase).Assembly
            .GetTypes()
            .Where(type => !type.IsAbstract && typeof(PlatformControllerBase).IsAssignableFrom(type));

        private static IEnumerable<MethodInfo> ActionsOf(Type controller) => controller
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(method => !method.IsSpecialName);

        [Fact]
        public void EveryPlatformControllerInheritsTheDenyByDefaultBase()
        {
            // A controller that sits under the platform route prefix but does NOT derive
            // from the base would silently escape the [Authorize] this all depends on.
            var strays = typeof(PlatformControllerBase).Assembly
                .GetTypes()
                .Where(type => !type.IsAbstract && typeof(ControllerBase).IsAssignableFrom(type))
                .Where(type => type.GetCustomAttributes<RouteAttribute>()
                    .Any(route => route.Template?.StartsWith(PlatformConstants.RoutePrefix, StringComparison.Ordinal) == true))
                .Where(type => !typeof(PlatformControllerBase).IsAssignableFrom(type))
                .Select(type => type.Name)
                .ToList();

            Assert.True(
                strays.Count == 0,
                "These controllers serve Platform v1 routes without deriving from PlatformControllerBase, "
                + "so they do not inherit its deny-by-default authorization: " + string.Join(", ", strays));
        }

        [Fact]
        public void NoUndeclaredAnonymousActionExists()
        {
            var anonymous = new List<string>();

            foreach (var controller in PlatformControllers)
            {
                foreach (var action in ActionsOf(controller))
                {
                    var isAnonymous = action.GetCustomAttribute<AllowAnonymousAttribute>() is not null
                        || controller.GetCustomAttribute<AllowAnonymousAttribute>() is not null;
                    if (isAnonymous)
                    {
                        anonymous.Add($"{controller.Name}.{action.Name}");
                    }
                }
            }

            var undeclared = anonymous.Where(name => !AllowedAnonymousActions.ContainsKey(name)).ToList();

            Assert.True(
                undeclared.Count == 0,
                "New anonymous Platform v1 action(s) appeared. If that is intended, add each to "
                + "AllowedAnonymousActions with the reason it may be reached without authentication: "
                + string.Join(", ", undeclared));
        }

        [Fact]
        public void AllowlistedAnonymousActionsStillExist()
        {
            // Anti-rot: an allowlist entry naming an action that has been renamed or
            // deleted stops describing anything, and quietly stops protecting anything.
            var missing = AllowedAnonymousActions.Keys
                .Where(entry =>
                {
                    var parts = entry.Split('.');
                    var controller = PlatformControllers.FirstOrDefault(type => type.Name == parts[0]);
                    return controller is null || ActionsOf(controller).All(action => action.Name != parts[1]);
                })
                .ToList();

            Assert.True(
                missing.Count == 0,
                "AllowedAnonymousActions names action(s) that no longer exist; remove the stale entries: "
                + string.Join(", ", missing));
        }

        [Fact]
        public void ActionsWithoutAnExplicitPolicyInheritAuthentication()
        {
            // The property that makes forgetting safe: an action that declares nothing
            // is authenticated, because the base says so.
            var baseAuthorize = typeof(PlatformControllerBase).GetCustomAttribute<AuthorizeAttribute>();
            Assert.NotNull(baseAuthorize);

            // A bare [Authorize] means "any signed-in user". Jellyfin 12 has no
            // Policies.DefaultAuthorization constant to name here — verified in EP-00,
            // where referencing it failed the build.
            Assert.Null(baseAuthorize!.Policy);
        }

        [Fact]
        public void ElevatedActionsUseTheOnlyPolicyJellyfin12Defines()
        {
            // If a platform action ever declares a policy, it must be the one the host
            // actually has. Anything else is a runtime 500 waiting to happen.
            var policies = PlatformControllers
                .SelectMany(ActionsOf)
                .Select(action => action.GetCustomAttribute<AuthorizeAttribute>()?.Policy)
                .Where(policy => !string.IsNullOrEmpty(policy))
                .Distinct()
                .ToList();

            Assert.All(policies, policy => Assert.Equal(Policies.RequiresElevation, policy));
        }
    }
}
