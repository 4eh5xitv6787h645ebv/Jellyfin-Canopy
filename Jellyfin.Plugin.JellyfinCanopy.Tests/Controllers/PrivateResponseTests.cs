using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Jellyfin.Plugin.JellyfinCanopy.Platform;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Controllers;
using Microsoft.AspNetCore.Mvc.Filters;
using Microsoft.AspNetCore.Mvc.Routing;
using Microsoft.AspNetCore.Routing;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Controllers
{
    public sealed class PrivateResponseTests
    {
        public static IEnumerable<object[]> PrivateActions()
        {
            Type[] privateControllers =
            [
                typeof(ActiveStreamsController), typeof(AnimeFillerWarningsController),
                typeof(ArrCalendarController), typeof(ArrLinksController),
                typeof(ArrRequestsController), typeof(ArrSearchController), typeof(AwardsController),
                typeof(HiddenContentController), typeof(MaintenanceModeController),
                typeof(ReviewsController), typeof(SeerrProxyController), typeof(SeerrScanTriggerController),
                typeof(SeerrUserController), typeof(ServiceDiscoveryController),
                typeof(SpoilerGuardController), typeof(TagCacheController),
                typeof(UserSettingsController), typeof(UserStoreRecoveryController),
                typeof(PlatformNativeController),
            ];
            foreach (var type in privateControllers)
            {
                foreach (var method in Actions(type))
                {
                    yield return [type, method.Name];
                }
            }

            yield return [typeof(ConfigController), nameof(ConfigController.GetPrivateConfig)];
            yield return [typeof(ConfigController), nameof(ConfigController.GetPublicConfig)];
            yield return [typeof(BrandingController), nameof(BrandingController.UploadBrandingImage)];
            yield return [typeof(BrandingController), nameof(BrandingController.DeleteBrandingImage)];
            yield return [typeof(PlatformDiscoveryController), nameof(PlatformDiscoveryController.Negotiate)];
            yield return [typeof(MaintainerrController), nameof(MaintainerrController.Test)];
            foreach (var method in Actions(typeof(ItemInfoController)).Where(m => m.Name != nameof(ItemInfoController.ProxyAvatar)))
            {
                yield return [typeof(ItemInfoController), method.Name];
            }
        }

        [Theory]
        [MemberData(nameof(PrivateActions))]
        public void PrivateAction_RejectsHttpStorageWithoutChangingItsRepresentation(Type controller, string action)
        {
            var method = controller.GetMethod(action)!;
            var policy = Policy(method);
            Assert.NotNull(policy);
            Assert.IsAssignableFrom<IAlwaysRunResultFilter>(policy);
            var http = new DefaultHttpContext();
            var payload = new { actor = "test-actor", items = new[] { "test-item" }, nextCursor = "test-cursor" };
            var result = new OkObjectResult(payload);
            var context = Context(http, method, result);
            http.Request.Headers.IfMatch = "\"12\"";
            http.Response.Headers.CacheControl = "public, max-age=3600";
            http.Response.Headers.Pragma = "cache";
            http.Response.Headers.Expires = "Thu, 01 Jan 2099 00:00:00 GMT";
            http.Response.Headers.ETag = "\"12\"";
            http.Response.Headers.LastModified = "Tue, 01 Sep 2026 00:00:00 GMT";
            http.Response.Headers.Vary = "Accept-Encoding, Origin";

            policy.OnResultExecuting(context);

            AssertNoStorage(http);
            Assert.Same(result, context.Result);
            Assert.Same(payload, Assert.IsType<OkObjectResult>(context.Result).Value);
            Assert.Equal("\"12\"", http.Response.Headers.ETag.ToString());
            Assert.Equal("\"12\"", http.Request.Headers.IfMatch.ToString());
            Assert.Equal("Tue, 01 Sep 2026 00:00:00 GMT", http.Response.Headers.LastModified.ToString());
            Assert.Equal("Accept-Encoding, Origin", http.Response.Headers.Vary.ToString());
        }

        [Theory]
        [InlineData(200)]
        [InlineData(204)]
        [InlineData(304)]
        [InlineData(400)]
        [InlineData(401)]
        [InlineData(403)]
        [InlineData(404)]
        [InlineData(409)]
        [InlineData(413)]
        [InlineData(429)]
        [InlineData(503)]
        public void ResultPolicy_PreservesSuccessAndShortCircuitStatuses(int status)
        {
            var method = typeof(UserSettingsController).GetMethod(nameof(UserSettingsController.GetUserSettingsSettings))!;
            var http = new DefaultHttpContext();
            http.Response.StatusCode = status;
            var result = new StatusCodeResult(status);
            var context = Context(http, method, result);
            var policy = Policy(method)!;

            policy.OnResultExecuting(context);
            policy.OnResultExecuted(new ResultExecutedContext(context, context.Filters, result, context.Controller));

            AssertNoStorage(http);
            Assert.Same(result, context.Result);
            Assert.Equal(status, http.Response.StatusCode);
            Assert.Equal(status, result.StatusCode);
            Assert.False(context.Cancel);
        }

        [Fact]
        public void PublicResourcesAndExplicitRevalidation_DoNotAcquirePrivatePolicy()
        {
            var exceptions = Actions(typeof(ConfigController))
                .Where(m => m.Name != nameof(ConfigController.GetPrivateConfig) && m.Name != nameof(ConfigController.GetPublicConfig))
                .Concat(Actions(typeof(AssetsController)))
                .Append(typeof(BrandingController).GetMethod(nameof(BrandingController.GetBrandingImage))!)
                .Append(typeof(ItemInfoController).GetMethod(nameof(ItemInfoController.ProxyAvatar))!)
                .Append(typeof(PlatformDiscoveryController).GetMethod(nameof(PlatformDiscoveryController.GetDiscovery))!);
            foreach (var method in exceptions)
            {
                Assert.Null(Policy(method));
            }
            Assert.Null(typeof(JellyfinCanopyControllerBase).GetCustomAttribute<PrivateResponseAttribute>(true));
            Assert.Null(typeof(PlatformControllerBase).GetCustomAttribute<PrivateResponseAttribute>(true));
        }

        [Theory]
        [InlineData(typeof(MaintainerrController))]
        [InlineData(typeof(QbittorrentTelemetryController))]
        public void ExistingPrivatePolicies_RemainExplicit(Type type)
        {
            foreach (var method in Actions(type))
            {
                if (Policy(method) != null) continue;
                var policy = method.GetCustomAttribute<ResponseCacheAttribute>();
                Assert.NotNull(policy);
                Assert.True(policy.NoStore);
                Assert.Equal(ResponseCacheLocation.None, policy.Location);
            }
        }

        internal static void ApplyToAction(ControllerBase controller, string action, IActionResult result)
        {
            var method = controller.GetType().GetMethod(action)!;
            Policy(method)!.OnResultExecuting(Context(controller.HttpContext, method, result));
            AssertNoStorage(controller.HttpContext);
        }

        private static IEnumerable<MethodInfo> Actions(Type type) => type
            .GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly)
            .Where(method => method.GetCustomAttributes<HttpMethodAttribute>().Any());

        private static PrivateResponseAttribute? Policy(MethodInfo method) =>
            method.GetCustomAttribute<PrivateResponseAttribute>(true)
            ?? method.DeclaringType!.GetCustomAttribute<PrivateResponseAttribute>(true);

        private static ResultExecutingContext Context(HttpContext http, MethodInfo method, IActionResult result)
        {
            var descriptor = new ControllerActionDescriptor
            {
                ControllerTypeInfo = method.DeclaringType!.GetTypeInfo(),
                MethodInfo = method,
            };
            return new ResultExecutingContext(
                new ActionContext(http, new RouteData(), descriptor),
                new List<IFilterMetadata>(), result, new object());
        }

        private static void AssertNoStorage(HttpContext http)
        {
            var policy = http.Response.GetTypedHeaders().CacheControl;
            Assert.NotNull(policy);
            Assert.True(policy.NoStore);
            Assert.True(policy.NoCache);
            Assert.True(policy.Private);
            Assert.False(policy.Public);
            Assert.Null(policy.MaxAge);
            Assert.Equal("no-cache", http.Response.Headers.Pragma.ToString());
            Assert.Equal("0", http.Response.Headers.Expires.ToString());
        }
    }
}
