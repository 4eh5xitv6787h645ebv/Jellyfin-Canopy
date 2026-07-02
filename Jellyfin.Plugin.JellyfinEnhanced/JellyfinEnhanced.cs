// Global aliases
global using JUser = Jellyfin.Database.Implementations.Entities.User;
global using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;

using System.Globalization;
using Jellyfin.Plugin.JellyfinEnhanced.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using MediaBrowser.Controller.Configuration;
using System.Text.Json.Nodes;
using MediaBrowser.Common.Net;
using System.Reflection;
using System.Runtime.Loader;

namespace Jellyfin.Plugin.JellyfinEnhanced
{
    public class JellyfinEnhanced : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        private readonly IApplicationPaths _applicationPaths;
        private readonly ILogger<JellyfinEnhanced> _logger;
        private const string PluginName = "Jellyfin Enhanced";

        public JellyfinEnhanced(IApplicationPaths applicationPaths, IServerConfigurationManager serverConfigurationManager, IXmlSerializer xmlSerializer, ILogger<JellyfinEnhanced> logger, Logging.JellyfinEnhancedFileLoggerProvider fileLogProvider) : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _applicationPaths = applicationPaths;
            _logger = logger;
            _logger.LogInformation($"{PluginName} v{Version} initialized. Plugin logs will be written to: {fileLogProvider.CurrentLogFilePath}");
            // Set the User-Agent used by every Seerr/TMDB outbound HTTP call.
            // Cloudflare's Browser Integrity Check / Bot Fight Mode flags
            // empty UA as bot.
            Helpers.Jellyseerr.SeerrHttpHelper.UserAgent = $"JellyfinEnhanced/{Version}";
            CleanupOldScript();
            CheckPluginPages(applicationPaths, serverConfigurationManager, 1);
            BackfillMissingDefaultShortcuts();
        }

        // Dedupes Shortcuts (XmlSerializer appends to constructor-initialized lists, doubling on each restart)
        // and backfills missing defaults. Reverse iteration so persisted XML rows win over constructor defaults.
        private void BackfillMissingDefaultShortcuts()
        {
            List<Shortcut>? originalShortcuts = null;
            try
            {
                var config = Configuration;
                if (config == null) return;
                config.Shortcuts ??= new List<Shortcut>();
                originalShortcuts = config.Shortcuts;

                var seen = new HashSet<string>(StringComparer.Ordinal);
                var dedupedReversed = new List<Shortcut>(originalShortcuts.Count);
                var emptyKeyNames = new HashSet<string>(StringComparer.Ordinal);
                for (int i = originalShortcuts.Count - 1; i >= 0; i--)
                {
                    var s = originalShortcuts[i];
                    var name = s?.Name ?? string.Empty;
                    if (string.IsNullOrEmpty(name)) continue;
                    if (string.IsNullOrEmpty(s?.Key))
                    {
                        emptyKeyNames.Add(name);
                        continue;
                    }
                    if (seen.Add(name)) dedupedReversed.Add(s!);
                }
                var deduped = new List<Shortcut>(dedupedReversed.Count);
                for (int i = dedupedReversed.Count - 1; i >= 0; i--) deduped.Add(dedupedReversed[i]);
                var malformed = emptyKeyNames.Where(n => !seen.Contains(n)).ToList();
                int duplicatesDropped = originalShortcuts.Count - deduped.Count - malformed.Count;

                var defaults = new PluginConfiguration().Shortcuts ?? new List<Shortcut>();
                var missing = defaults.Where(d => !seen.Contains(d.Name ?? string.Empty)).ToList();
                deduped.AddRange(missing);

                if (duplicatesDropped == 0 && missing.Count == 0 && malformed.Count == 0) return;

                config.Shortcuts = deduped;
                SaveConfiguration();
                _logger.LogInformation(
                    $"Normalized shortcut list: dropped {duplicatesDropped} duplicate(s), " +
                    $"{malformed.Count} malformed entry/entries" +
                    (malformed.Count > 0 ? $" [{string.Join(", ", malformed)}]" : "") +
                    $", added {missing.Count} missing default(s)" +
                    (missing.Count > 0 ? $" [{string.Join(", ", missing.Select(s => s.Name))}]" : ""));
            }
            catch (IOException ex)
            {
                RollbackShortcuts(originalShortcuts);
                _logger.LogError($"Failed to save normalized shortcut list to disk (check permissions and free space): {ex}");
            }
            catch (UnauthorizedAccessException ex)
            {
                RollbackShortcuts(originalShortcuts);
                _logger.LogError($"Permission denied saving normalized shortcut list: {ex}");
            }
            catch (Exception ex)
            {
                RollbackShortcuts(originalShortcuts);
                _logger.LogError($"Unexpected error normalizing shortcut list: {ex}");
            }
        }

        private void RollbackShortcuts(List<Shortcut>? original)
        {
            if (original == null) return;
            try
            {
                var config = Configuration;
                if (config != null) config.Shortcuts = original;
            }
            catch (Exception ex)
            {
                _logger.LogError($"Failed to roll back shortcut list after save failure: {ex}");
            }
        }

        public override string Name => PluginName;
        public override Guid Id => Guid.Parse("f69e946a-4b3c-4e9a-8f0a-8d7c1b2c4d9b");
        public static JellyfinEnhanced? Instance { get; private set; }

        private string IndexHtmlPath => Path.Combine(_applicationPaths.WebPath, "index.html");

        public static string BrandingDirectory
        {
            get
            {
                if (Instance == null)
                    return string.Empty;

                var configPath = Instance.ConfigurationFilePath;
                if (string.IsNullOrWhiteSpace(configPath))
                    return string.Empty;

                var configDir = Path.GetDirectoryName(configPath);
                if (string.IsNullOrWhiteSpace(configDir))
                    return string.Empty;

                var pluginFolderName = Path.GetFileNameWithoutExtension(configPath) ?? "Jellyfin.Plugin.JellyfinEnhanced";
                return Path.Combine(configDir, pluginFolderName, "custom_branding");
            }
        }

        // Cache-busting key: plugin version plus the DLL's last-write timestamp, so
        // every build yields a distinct value even when the version is unchanged
        // (local dev/testing). Falls back to the bare version if the assembly
        // location can't be read (e.g. single-file hosting).
        internal string ScriptCacheKey
        {
            get
            {
                var version = Version?.ToString() ?? "unknown";
                try
                {
                    var location = typeof(JellyfinEnhanced).Assembly.Location;
                    if (!string.IsNullOrEmpty(location) && File.Exists(location))
                    {
                        var ticks = new FileInfo(location).LastWriteTimeUtc.Ticks;
                        return $"{version}-{ticks}";
                    }
                }
                catch (Exception ex)
                {
                    // Fall through to the bare version below.
                    _logger.LogDebug($"ScriptCacheKey: couldn't read assembly file metadata, using bare version: {ex.Message}");
                }

                return version;
            }
        }

        // The single source of truth for the client-script tag. Consumed both by the
        // request-time injection middleware (ScriptInjectionStartupFilter) and by the
        // legacy on-disk index.html rewrite, so the two never drift. plugin.js reads
        // the plugin/version/dev attributes off this tag.
        internal string BuildScriptTag()
        {
            var cacheKey = ScriptCacheKey;
            var devMode = Configuration?.DevMode == true;
            return $"<script plugin=\"{Name}\" version=\"{cacheKey}\" dev=\"{(devMode ? "true" : "false")}\" src=\"../JellyfinEnhanced/script?v={cacheKey}\" defer></script>";
        }

        public void InjectScript()
        {
            UpdateIndexHtml(true);
        }

        public override void OnUninstalling()
        {
            UpdateIndexHtml(false);
            base.OnUninstalling();
        }

        // Flush every Seerr-related cache the moment the admin saves config.
        // Without this, fixing a bad URL/key/blocklist takes 10-30 minutes to
        // take effect because of the user-id and response caches — admins see
        // "still broken" after their fix and assume it didn't work
        //.
        public override void UpdateConfiguration(BasePluginConfiguration configuration)
        {
            base.UpdateConfiguration(configuration);
            try
            {
                // The plugin itself is not DI-resolved; SeerrCache.Instance is the
                // transitional bridge to the one DI-registered cache singleton the
                // controllers use. Null only before the first cache consumer is
                // constructed, i.e. when there is nothing to clear yet.
                Services.Jellyseerr.SeerrCache.Instance?.ClearAllSeerrCachesOnConfigChange();
                _logger.LogInformation("Jellyfin Enhanced: configuration updated — Seerr caches cleared.");
            }
            catch (Exception ex)
            {
                _logger.LogWarning($"Jellyfin Enhanced: failed to clear Seerr caches on config update: {ex.Message}");
            }
        }
        private void CleanupOldScript()
        {
            try
            {
                var indexPath = IndexHtmlPath;
                if (!File.Exists(indexPath))
                {
                    _logger.LogError($"Could not find index.html at path: {indexPath}");
                    return;
                }

                var content = File.ReadAllText(indexPath);
                var regex = new Regex($"<script[^>]*plugin=[\"']{Name}[\"'][^>]*>\\s*</script>\\n?");

                if (regex.IsMatch(content))
                {
                    _logger.LogInformation("Found old Jellyfin Enhanced script tag in index.html. Removing it now.");
                    content = regex.Replace(content, string.Empty);
                    File.WriteAllText(indexPath, content);
                    _logger.LogInformation("Successfully removed old script tag.");
                }
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error during cleanup of old script from index.html: {ex.Message}");
            }
        }
        private void CheckPluginPages(IApplicationPaths applicationPaths, IServerConfigurationManager serverConfigurationManager, int pluginPageConfigVersion)
        {
            try
            {
            string pluginPagesConfig = Path.Combine(applicationPaths.PluginConfigurationsPath, "Jellyfin.Plugin.PluginPages", "config.json");

            JsonObject config = new JsonObject();
            if (!File.Exists(pluginPagesConfig))
            {
                FileInfo info = new FileInfo(pluginPagesConfig);
                info.Directory?.Create();
            }
            else
            {
                // AsObject() throws on a non-object root, like JObject.Parse did —
                // the outer catch turns either into a logged error, never a rewrite.
                config = JsonNode.Parse(File.ReadAllText(pluginPagesConfig))!.AsObject();
            }

            if (!config.ContainsKey("pages"))
            {
                config.Add("pages", new JsonArray());
            }

            var namespaceName = typeof(JellyfinEnhanced).Namespace;
            var pages = config["pages"]!.AsArray();

            JsonObject? hssPageConfig = pages.FirstOrDefault(x =>
                (string?)x?["Id"] == namespaceName) as JsonObject;

            if (hssPageConfig != null)
            {
                if (((int?)hssPageConfig["Version"] ?? 0) < pluginPageConfigVersion)
                {
                    pages.Remove(hssPageConfig);
                }
            }

            Assembly? pluginPagesAssembly = AssemblyLoadContext.All.SelectMany(x => x.Assemblies).FirstOrDefault(x => x.FullName?.Contains("Jellyfin.Plugin.PluginPages") ?? false);

            Version earliestVersionWithSubUrls = new Version("2.4.1.0");
            bool supportsSubUrls = pluginPagesAssembly != null && pluginPagesAssembly.GetName().Version >= earliestVersionWithSubUrls;

            string rootUrl = serverConfigurationManager.GetNetworkConfiguration().BaseUrl.TrimStart('/').Trim();
            if (!string.IsNullOrEmpty(rootUrl))
            {
                rootUrl = $"/{rootUrl}";
            }

            var pluginConfig = Configuration;

            bool calendarExists = pages
                .Any(x => (string?)x?["Id"] == $"{namespaceName}.CalendarPage");

            bool downloadsExists = pages
                .Any(x => (string?)x?["Id"] == $"{namespaceName}.DownloadsPage");

            bool bookmarksExists = pages
                .Any(x => (string?)x?["Id"] == $"{namespaceName}.BookmarksPage");

            bool hiddenContentExists = pages
                .Any(x => (string?)x?["Id"] == $"{namespaceName}.HiddenContentPage");

            // Only add calendar page if it's enabled and using plugin pages
            if (!calendarExists && pluginConfig.CalendarPageEnabled && pluginConfig.CalendarUsePluginPages)
            {
                pages.Add(new JsonObject
                {
                    { "Id", $"{namespaceName}.CalendarPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinEnhanced/calendarPage" },
                    { "DisplayText", "Calendar" },
                    { "Icon", "calendar_today" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove calendar page if it exists but is now disabled or not using plugin pages
            else if (calendarExists && (!pluginConfig.CalendarPageEnabled || !pluginConfig.CalendarUsePluginPages))
            {
                var calendarPage = pages
                    .FirstOrDefault(x => (string?)x?["Id"] == $"{namespaceName}.CalendarPage");
                if (calendarPage != null)
                {
                    pages.Remove(calendarPage);
                }
            }

            // Only add downloads page if it's enabled and using plugin pages
            if (!downloadsExists && pluginConfig.DownloadsPageEnabled && pluginConfig.DownloadsUsePluginPages)
            {
                pages.Add(new JsonObject
                {
                    { "Id", $"{namespaceName}.DownloadsPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinEnhanced/downloadsPage" },
                    { "DisplayText", "Requests" },
                    { "Icon", "download" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove downloads page if it exists but is now disabled or not using plugin pages
            else if (downloadsExists && (!pluginConfig.DownloadsPageEnabled || !pluginConfig.DownloadsUsePluginPages))
            {
                var downloadsPage = pages
                    .FirstOrDefault(x => (string?)x?["Id"] == $"{namespaceName}.DownloadsPage");
                if (downloadsPage != null)
                {
                    pages.Remove(downloadsPage);
                }
            }

            // Only add bookmarks page if it's enabled and using plugin pages
            if (!bookmarksExists && pluginConfig.BookmarksEnabled && pluginConfig.BookmarksUsePluginPages)
            {
                pages.Add(new JsonObject
                {
                    { "Id", $"{namespaceName}.BookmarksPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinEnhanced/bookmarksPage" },
                    { "DisplayText", "Bookmarks" },
                    { "Icon", "bookmark" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove bookmarks page if it exists but is now disabled or not using plugin pages
            else if (bookmarksExists && (!pluginConfig.BookmarksEnabled || !pluginConfig.BookmarksUsePluginPages))
            {
                var bookmarksPage = pages
                    .FirstOrDefault(x => (string?)x?["Id"] == $"{namespaceName}.BookmarksPage");
                if (bookmarksPage != null)
                {
                    pages.Remove(bookmarksPage);
                }
            }

            // Only add hidden content page if it's enabled and using plugin pages
            if (!hiddenContentExists && pluginConfig.HiddenContentEnabled && pluginConfig.HiddenContentUsePluginPages)
            {
                pages.Add(new JsonObject
                {
                    { "Id", $"{namespaceName}.HiddenContentPage" },
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinEnhanced/hiddenContentPage" },
                    { "DisplayText", "Hidden Content" },
                    { "Icon", "visibility_off" },
                    { "Version", pluginPageConfigVersion }
                });
            }
            // Remove hidden content page if it exists but is now disabled or not using plugin pages
            else if (hiddenContentExists && (!pluginConfig.HiddenContentEnabled || !pluginConfig.HiddenContentUsePluginPages))
            {
                var hiddenContentPage = pages
                    .FirstOrDefault(x => (string?)x?["Id"] == $"{namespaceName}.HiddenContentPage");
                if (hiddenContentPage != null)
                {
                    pages.Remove(hiddenContentPage);
                }
            }

            // PluginPages' config.json is admin-visible on disk: keep the same
            // human-readable shape JObject.ToString(Formatting.Indented) produced
            // (2-space indent, raw non-ASCII) via the shared persistence options.
            File.WriteAllText(pluginPagesConfig, config.ToJsonString(PersistedJson.WriteOptions));
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error while updating Plugin Pages configuration: {ex.Message}");
            }
        }
        private void UpdateIndexHtml(bool inject)
        {
            try
            {
                var indexPath = IndexHtmlPath;
                if (!File.Exists(indexPath))
                {
                    _logger.LogError($"Could not find index.html at path: {indexPath}");
                    return;
                }

                var content = File.ReadAllText(indexPath);
                var scriptTag = BuildScriptTag();
                var regex = new Regex($"<script[^>]*plugin=[\"']{Name}[\"'][^>]*>\\s*</script>\\n?");

                // Remove any old versions of the script tag first
                content = regex.Replace(content, string.Empty);

                if (inject)
                {
                    var closingBodyTag = "</body>";
                    if (content.Contains(closingBodyTag))
                    {
                        content = content.Replace(closingBodyTag, $"{scriptTag}\n{closingBodyTag}");
                        _logger.LogInformation($"Successfully injected/updated the {PluginName} script.");
                    }
                    else
                    {
                        _logger.LogWarning("Could not find </body> tag in index.html. Script not injected.");
                        return; // Return early if injection point not found
                    }
                }
                else
                {
                    _logger.LogInformation($"Successfully removed the {PluginName} script from index.html during uninstall.");
                }

                File.WriteAllText(indexPath, content);
            }
            catch (Exception ex)
            {
                _logger.LogError($"Error while trying to update index.html: {ex.Message}");
            }
        }

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = this.Name,
                    DisplayName = "Jellyfin Enhanced",
                    EnableInMainMenu = true,
                    EmbeddedResourcePath = "Jellyfin.Plugin.JellyfinEnhanced.Configuration.configPage.html",
                    // MenuIcon was previously ignored - jellyfin-web hardcoded <Folder /> regardless of
                    // this value. Jellyfin 12 reads it https://github.com/jellyfin/jellyfin-web/commit/ca55f7998bb774b3c05af3ae410b1b24f72805a5
                    MenuIcon = "tune"
                }
            };
        }

        public IEnumerable<PluginPageInfo> GetViews()
        {
            return new[]
            {
                new PluginPageInfo {
                    Name = "calendarPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.CalendarPage.html"
                },
                new PluginPageInfo {
                    Name = "downloadsPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.DownloadsPage.html"
                },
                new PluginPageInfo {
                    Name = "bookmarksPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.BookmarksPage.html"
                },
                new PluginPageInfo {
                    Name = "hiddenContentPage",
                    EmbeddedResourcePath = $"{GetType().Namespace}.PluginPages.HiddenContentPage.html"
                }
            };
        }
    }
}