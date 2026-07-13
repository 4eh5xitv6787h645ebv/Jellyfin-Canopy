// Global aliases
global using JUser = Jellyfin.Database.Implementations.Entities.User;
global using JSortOrder = Jellyfin.Database.Implementations.Enums.SortOrder;

using System.Globalization;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
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

namespace Jellyfin.Plugin.JellyfinCanopy
{
    public class JellyfinCanopy : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        private readonly IApplicationPaths _applicationPaths;
        private readonly ILogger<JellyfinCanopy> _logger;
        private const string PluginName = "Jellyfin Canopy";

        // The plugin's pre-rebrand identity (shipped as "Jellyfin Elevate" ≤ 1.x, same GUID).
        // Used only to migrate persisted state and clean up artifacts left by those builds.
        private const string LegacyPluginName = "Jellyfin Elevate";
        private const string LegacyAssemblyName = "Jellyfin.Plugin.JellyfinElevate";

        public JellyfinCanopy(IApplicationPaths applicationPaths, IServerConfigurationManager serverConfigurationManager, IXmlSerializer xmlSerializer, ILogger<JellyfinCanopy> logger, Logging.JellyfinCanopyFileLoggerProvider fileLogProvider) : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
            _applicationPaths = applicationPaths;
            _logger = logger;
            // Must run before anything touches Configuration: BasePlugin loads the
            // config XML lazily on first access, so adopting the legacy file here
            // means the first load already sees the migrated copy.
            MigrateLegacyElevateState(applicationPaths);
            // After the file itself is adopted, rename any pre-rename "Jellyseerr"
            // element names inside it — a ≤2.0 config would otherwise deserialize
            // those settings to defaults. A failed migration arms the write
            // suppressor below: saving the defaults-loaded configuration would
            // permanently overwrite the legacy values the retry depends on.
            _configWritesSuspendedByFailedMigration = !MigrateLegacySeerrElementNamesCore(ConfigurationFilePath, msg => _logger.LogInformation(msg), msg => _logger.LogError(msg));
            _logger.LogInformation($"{PluginName} v{Version} initialized. Plugin logs will be written to: {fileLogProvider.CurrentLogFilePath}");
            // Set the User-Agent used by every Seerr/TMDB outbound HTTP call.
            // Cloudflare's Browser Integrity Check / Bot Fight Mode flags
            // empty UA as bot.
            Helpers.Seerr.SeerrHttpHelper.UserAgent = $"JellyfinCanopy/{Version}";
            CleanupOldScript();
            CheckPluginPages(applicationPaths, serverConfigurationManager, 1);
            BackfillMissingDefaultShortcuts();
        }

        /// <summary>
        /// One-time upgrade migration from the plugin's former "Jellyfin Elevate"
        /// identity (same GUID, different assembly name). Adopts the legacy config
        /// XML and the legacy plugin-data directory (custom_branding, asset_cache,
        /// user settings) under their new Canopy names so an in-place upgrade loses
        /// no state. Both steps are idempotent no-ops once the new names exist, and
        /// any failure degrades to first-run defaults instead of blocking startup.
        /// </summary>
        private void MigrateLegacyElevateState(IApplicationPaths applicationPaths)
        {
            MigrateLegacyStateCore(
                applicationPaths.PluginConfigurationsPath,
                ConfigurationFilePath,
                Path.GetFileNameWithoutExtension(ConfigurationFileName),
                msg => _logger.LogInformation(msg),
                msg => _logger.LogError(msg));
        }

        // Static core of the rebrand migration, separated from BasePlugin so the
        // filesystem behavior is unit-testable against plain temp directories.
        internal static void MigrateLegacyStateCore(string configDir, string newConfigFilePath, string newDataDirName, Action<string> logInfo, Action<string> logError)
        {
            try
            {
                var legacyConfigPath = Path.Combine(configDir, LegacyAssemblyName + ".xml");
                if (File.Exists(legacyConfigPath) && !File.Exists(newConfigFilePath))
                {
                    // Copy (not move) so a rollback to the old DLL still finds its
                    // file, and publish via temp + rename so an interrupted copy can
                    // never leave a partial file at the authoritative path (which
                    // would block every later retry behind the File.Exists guard).
                    var tempPath = newConfigFilePath + ".migrating";
                    File.Copy(legacyConfigPath, tempPath, overwrite: true);
                    File.Move(tempPath, newConfigFilePath);
                    logInfo($"Migrated legacy {LegacyPluginName} configuration to {Path.GetFileName(newConfigFilePath)}.");
                }
            }
            catch (Exception ex)
            {
                logError($"Failed to migrate the legacy {LegacyPluginName} configuration file; starting with defaults (will retry next startup): {ex.Message}");
            }

            try
            {
                var legacyDataDir = Path.Combine(configDir, LegacyAssemblyName);
                var newDataDir = Path.Combine(configDir, newDataDirName);
                if (Directory.Exists(legacyDataDir))
                {
                    // An empty Canopy directory is retry-safe debris: a hosted service
                    // creates the root eagerly, so a failed first migration would
                    // otherwise strand the legacy data forever behind the exists-check.
                    if (Directory.Exists(newDataDir) && !Directory.EnumerateFileSystemEntries(newDataDir).Any())
                    {
                        Directory.Delete(newDataDir);
                    }

                    if (!Directory.Exists(newDataDir))
                    {
                        // Same parent directory, so this is an atomic rename — the cached
                        // assets and per-user data can be large, copying is not an option.
                        Directory.Move(legacyDataDir, newDataDir);
                        logInfo($"Migrated legacy {LegacyPluginName} data directory to {Path.GetFileName(newDataDir)}.");
                    }
                    else
                    {
                        // Both roots hold data: never guess which one wins. Keep both
                        // intact and say exactly where the stranded data lives.
                        logError($"Both the legacy {LegacyPluginName} data directory ({legacyDataDir}) and its {PluginName} replacement contain data; leaving both untouched — move the legacy contents manually if anything is missing.");
                    }
                }
            }
            catch (Exception ex)
            {
                logError($"Failed to migrate the legacy {LegacyPluginName} data directory; caches and per-user data will rebuild (will retry next startup): {ex.Message}");
            }
        }

        // Pre-rename builds (≤ 2.0) persisted the Seerr settings under
        // "Jellyseerr*" XML element names. XmlSerializer maps strictly by element
        // name, so without this one-time rename those settings would silently
        // deserialize to defaults after the upgrade. ONLY element names are
        // rewritten — element VALUES are user data and legitimately contain the
        // string (e.g. a Seerr instance whose docker hostname is "jellyseerr").
        // Idempotent: once no element name carries the legacy fragment, nothing
        // is written.
        //
        // Returns false ONLY when a legacy config exists but could not be
        // migrated. The caller must then suppress every configuration write for
        // this startup: the un-migrated settings load as defaults, and any save
        // would persist those defaults under the new names — permanently
        // destroying the legacy values the retry-next-startup promise depends on.
        internal static bool MigrateLegacySeerrElementNamesCore(string configFilePath, Action<string> logInfo, Action<string> logError)
        {
            const string legacyFragment = "Jellyseerr";
            try
            {
                if (!File.Exists(configFilePath))
                {
                    return true;
                }

                var document = System.Xml.Linq.XDocument.Load(configFilePath, System.Xml.Linq.LoadOptions.PreserveWhitespace);
                var renamed = 0;
                foreach (var element in document.Descendants())
                {
                    var localName = element.Name.LocalName;
                    if (localName.Contains(legacyFragment, StringComparison.Ordinal))
                    {
                        element.Name = System.Xml.Linq.XName.Get(
                            localName.Replace(legacyFragment, "Seerr", StringComparison.Ordinal),
                            element.Name.NamespaceName);
                        renamed++;
                    }
                }

                if (renamed == 0)
                {
                    return true;
                }

                // Durable atomic publish (temp sibling + fsync + rename) via the
                // shared owner, so a crash mid-migration can never leave a
                // truncated or torn config at the authoritative path.
                using var buffer = new MemoryStream();
                document.Save(buffer);
                AtomicFile.WriteAllBytes(configFilePath, buffer.ToArray());
                logInfo($"Renamed {renamed} legacy Jellyseerr-era configuration elements to their Seerr names.");
                return true;
            }
            catch (Exception ex)
            {
                logError($"Failed to rename legacy Jellyseerr-era configuration elements; configuration writes are suspended until the migration succeeds on a later startup: {ex.Message}");
                return false;
            }
        }

        /// <summary>
        /// Server-side save hook. Jellyfin core routes admin config saves through
        /// <c>POST /Plugins/{id}/Configuration</c> → this method. We sanitise the optional
        /// external/public service URLs here so an obviously-malformed value (missing scheme,
        /// non-http(s), stray whitespace) is blanked before it is persisted and can never reach
        /// browser link building. This mirrors the config-page's client-side scheme check as
        /// defence-in-depth; every other field passes through untouched, so a bad external URL
        /// degrades to "use the internal URL" instead of rejecting the whole save.
        /// </summary>
        public override void UpdateConfiguration(BasePluginConfiguration configuration)
        {
            if (configuration is PluginConfiguration config)
            {
                SanitizeExternalUrlFields(config);
            }

            base.UpdateConfiguration(configuration);
        }

        // Armed when the legacy Jellyseerr-name migration failed: the loaded
        // Configuration then holds defaults for every un-migrated setting, and
        // persisting it (startup backfills, scheduled-task saves, admin saves)
        // would overwrite the legacy XML with those defaults — permanent data
        // loss. All plugin config writes funnel through SaveConfiguration, so
        // suppressing here protects the file until a later startup migrates it.
        private bool _configWritesSuspendedByFailedMigration;

        public override void SaveConfiguration()
        {
            if (_configWritesSuspendedByFailedMigration)
            {
                _logger.LogError("Configuration save suppressed: the legacy Jellyseerr-name migration failed this startup, and saving now would overwrite the un-migrated settings with defaults. Fix the configuration file/permissions and restart Jellyfin; changes made this session are not persisted.");
                return;
            }

            base.SaveConfiguration();
        }

        private void SanitizeExternalUrlFields(PluginConfiguration config)
        {
            static void Sanitize(string? value, Action<string> assign, string field, ILogger<JellyfinCanopy> logger)
            {
                var cleaned = Helpers.ServiceUrlResolver.SanitizeExternalUrl(value);
                if (!string.Equals(cleaned, value ?? string.Empty, StringComparison.Ordinal)
                    && !string.IsNullOrWhiteSpace(value))
                {
                    logger.LogWarning($"Dropped malformed external URL for {field} on save (must be an absolute http:// or https:// URL): {value}");
                }

                assign(cleaned);
            }

            Sanitize(config.SeerrExternalUrl, v => config.SeerrExternalUrl = v, nameof(config.SeerrExternalUrl), _logger);
            Sanitize(config.SonarrExternalUrl, v => config.SonarrExternalUrl = v, nameof(config.SonarrExternalUrl), _logger);
            Sanitize(config.RadarrExternalUrl, v => config.RadarrExternalUrl = v, nameof(config.RadarrExternalUrl), _logger);
            Sanitize(config.BazarrExternalUrl, v => config.BazarrExternalUrl = v, nameof(config.BazarrExternalUrl), _logger);

            // Per-instance ExternalUrl inside the SonarrInstances/RadarrInstances JSON: the
            // config-page validator can be bypassed by a direct config POST or hand edit, so the
            // save hook is the authoritative gate. Corrupt JSON is deliberately left untouched
            // (the corruption-recovery flow owns it) — see ServiceUrlResolver for the rules.
            config.SonarrInstances = Helpers.ServiceUrlResolver.SanitizeInstanceExternalUrlsJson(
                config.SonarrInstances,
                (name, value) => _logger.LogWarning($"Dropped malformed external URL for SonarrInstances instance \"{name}\" on save (must be an absolute http:// or https:// URL without credentials/query/fragment): {value}"));
            config.RadarrInstances = Helpers.ServiceUrlResolver.SanitizeInstanceExternalUrlsJson(
                config.RadarrInstances,
                (name, value) => _logger.LogWarning($"Dropped malformed external URL for RadarrInstances instance \"{name}\" on save (must be an absolute http:// or https:// URL without credentials/query/fragment): {value}"));
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
        public override Guid Id => Guid.Parse("9ffa12bc-f4b5-406c-ab1d-d575acbeea7b");
        public static JellyfinCanopy? Instance { get; private set; }

        private string IndexHtmlPath => Path.Combine(_applicationPaths.WebPath, "index.html");

        public static string BrandingDirectory => GetPluginDataSubdirectory("custom_branding");

        /// <summary>
        /// On-disk root of the third-party asset mirror (see Services.AssetCacheService),
        /// a sibling of the custom-branding directory next to the plugin config.
        /// </summary>
        public static string AssetCacheDirectory => GetPluginDataSubdirectory("asset_cache");

        private static string GetPluginDataSubdirectory(string name)
        {
            if (Instance == null)
                return string.Empty;

            var configPath = Instance.ConfigurationFilePath;
            if (string.IsNullOrWhiteSpace(configPath))
                return string.Empty;

            var configDir = Path.GetDirectoryName(configPath);
            if (string.IsNullOrWhiteSpace(configDir))
                return string.Empty;

            var pluginFolderName = Path.GetFileNameWithoutExtension(configPath) ?? "Jellyfin.Plugin.JellyfinCanopy";
            return Path.Combine(configDir, pluginFolderName, name);
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
                    var location = typeof(JellyfinCanopy).Assembly.Location;
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
            return $"<script plugin=\"{Name}\" version=\"{cacheKey}\" dev=\"{(devMode ? "true" : "false")}\" src=\"../JellyfinCanopy/script?v={cacheKey}\" defer></script>";
        }

        // Matches this plugin's injected script tag under its current name AND its
        // legacy "Jellyfin Elevate" name, so upgrading across the rebrand removes
        // the stale tag (whose /JellyfinElevate/script URL no longer resolves)
        // instead of leaving a 404ing double-load behind.
        internal static Regex OwnScriptTagRegex() =>
            new Regex($"<script[^>]*plugin=[\"'](?:{Regex.Escape(PluginName)}|{Regex.Escape(LegacyPluginName)})[\"'][^>]*>\\s*</script>\\n?");

        public void InjectScript()
        {
            UpdateIndexHtml(true);
        }

        public override void OnUninstalling()
        {
            UpdateIndexHtml(false);
            base.OnUninstalling();
        }

        // Seerr caches are flushed the moment the admin saves config by
        // Services.LiveNotifierService, a DI hosted service that subscribes to
        // BasePlugin<T>.ConfigurationChanged (raised here by base.UpdateConfiguration)
        // and reaches the one cache singleton the controllers use via DI — no static
        // bridge, and it ALSO pushes a live "config-changed" message to open
        // sessions so admin saves hot-reload with no manual refresh.
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
                var regex = OwnScriptTagRegex();

                if (regex.IsMatch(content))
                {
                    _logger.LogInformation("Found old Jellyfin Canopy script tag in index.html. Removing it now.");
                    content = regex.Replace(content, string.Empty);
                    AtomicFile.WriteAllText(indexPath, content);
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
                // ParseOptions keeps Newtonsoft's tolerance for comments/trailing
                // commas: this file may be hand-edited or written by other tools,
                // and JObject.Parse accepted both.
                config = JsonNode.Parse(
                    File.ReadAllText(pluginPagesConfig),
                    documentOptions: PersistedJson.ParseOptions)!.AsObject();
            }

            // Baseline serialization of what we read, so we only rewrite the file
            // when JC actually changes the pages array (avoids per-boot phantom churn).
            string originalJson = config.ToJsonString(PersistedJson.WriteOptions);

            if (!config.ContainsKey("pages"))
            {
                config.Add("pages", new JsonArray());
            }

            var namespaceName = typeof(JellyfinCanopy).Namespace;
            var pages = config["pages"]!.AsArray();

            // Rebrand migration: entries registered by pre-2.0 "Jellyfin Elevate"
            // builds point at /JellyfinElevate/* URLs that no longer resolve, and
            // would duplicate the Canopy entries added below. Remove them once.
            for (int i = pages.Count - 1; i >= 0; i--)
            {
                var pageId = (string?)pages[i]?["Id"];
                if (pageId != null && pageId.StartsWith(LegacyAssemblyName, StringComparison.Ordinal))
                {
                    pages.RemoveAt(i);
                }
            }

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
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinCanopy/calendarPage" },
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
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinCanopy/downloadsPage" },
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
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinCanopy/bookmarksPage" },
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
                    { "Url", $"{(supportsSubUrls ? "" : rootUrl)}/JellyfinCanopy/hiddenContentPage" },
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
            // Atomic + write-only-when-changed: we cannot share a lock with the PluginPages
            // plugin, so this closes torn-write corruption and minimizes the race window,
            // not the cross-process race itself. The dirty-check also stops the phantom
            // per-boot rewrite (and comment-strip) when the pages array is unchanged.
            string newJson = config.ToJsonString(PersistedJson.WriteOptions);
            if (!string.Equals(newJson, originalJson, StringComparison.Ordinal))
            {
                AtomicFile.WriteAllText(pluginPagesConfig, newJson);
            }
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
                var regex = OwnScriptTagRegex();

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

                AtomicFile.WriteAllText(indexPath, content);
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
                    DisplayName = "Jellyfin Canopy",
                    EnableInMainMenu = true,
                    EmbeddedResourcePath = "Jellyfin.Plugin.JellyfinCanopy.Configuration.configPage.html",
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