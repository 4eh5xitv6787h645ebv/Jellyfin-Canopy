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
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

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

        public JellyfinCanopy(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer, ILogger<JellyfinCanopy> logger, Logging.JellyfinCanopyFileLoggerProvider fileLogProvider) : base(applicationPaths, xmlSerializer)
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
            CleanupManagedCustomTabs(applicationPaths);
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
        // persisting it (startup backfills, scheduled-task saves, admin saves,
        // and BasePlugin.LoadConfiguration's own on-deserialization-failure
        // save) would overwrite the legacy XML with those defaults — permanent
        // data loss. Every write path ends in the TYPED SaveConfiguration
        // virtual (the parameterless overload delegates to it), so guarding it
        // here protects the file until a later startup migrates successfully.
        private bool _configWritesSuspendedByFailedMigration;

        public override void SaveConfiguration(PluginConfiguration config)
        {
            if (_configWritesSuspendedByFailedMigration)
            {
                _logger.LogError("Configuration save suppressed: the legacy Jellyseerr-name migration failed this startup, and saving now would overwrite the un-migrated settings with defaults. Fix the configuration file/permissions and restart Jellyfin; changes made this session are not persisted.");
                return;
            }

            base.SaveConfiguration(config);
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
        // One-time startup cleanup for the retired Custom-Tabs delivery mode. Until
        // the 2.x pages-framework rework, Jellyfin Canopy could push a home-page tab
        // into the external Custom Tabs plugin for each of its pages (Bookmarks,
        // Requests, Calendar, Hidden Content). That delivery mode is gone and the
        // config-page.js sync that managed those entries was deleted, so this removes
        // the entries the sync left behind — otherwise an upgraded user is stranded
        // with tabs that open to empty/broken content. Follows the rebrand-migration
        // pattern: static core, idempotent (only writes when a Canopy-owned entry is
        // present, so it is effectively a one-shot), atomic temp+rename write, and any
        // failure degrades with a log without ever blocking startup.
        private void CleanupManagedCustomTabs(IApplicationPaths applicationPaths)
        {
            // The Custom Tabs plugin (IAmParadox27, GUID fbacd0b6-…) stores its config
            // as a standard Jellyfin BasePluginConfiguration — an XML file next to the
            // plugin config, NOT a JSON file. Canopy's entries were written through the
            // plugin's HTTP config endpoint, so on disk they live inside this XML.
            var customTabsConfigPath = Path.Combine(
                applicationPaths.PluginConfigurationsPath,
                "Jellyfin.Plugin.CustomTabs.xml");
            var ownedFlags = new HashSet<string>(StringComparer.Ordinal);
            if (Configuration.BookmarksCustomTabJeOwned) ownedFlags.Add("BookmarksCustomTabJeOwned");
            if (Configuration.DownloadsCustomTabJeOwned) ownedFlags.Add("DownloadsCustomTabJeOwned");
            if (Configuration.CalendarCustomTabJeOwned) ownedFlags.Add("CalendarCustomTabJeOwned");
            if (Configuration.HiddenContentCustomTabJeOwned) ownedFlags.Add("HiddenContentCustomTabJeOwned");
            var cleanupSucceeded = CleanupManagedCustomTabsCore(
                customTabsConfigPath,
                ownedFlags,
                msg => _logger.LogInformation(msg),
                msg => _logger.LogError(msg));
            if (cleanupSucceeded && ownedFlags.Count > 0)
            {
                // The ownership state has served its purpose; clear it so this
                // migration never re-fires. (Persisted via the normal save path,
                // which the failed-seerr-migration suppressor may veto — in that
                // case the flags simply survive to the next startup.)
                Configuration.BookmarksCustomTabJeOwned = false;
                Configuration.DownloadsCustomTabJeOwned = false;
                Configuration.CalendarCustomTabJeOwned = false;
                Configuration.HiddenContentCustomTabJeOwned = false;
                SaveConfiguration(Configuration);
            }

            // The retired PluginPages integration wrote page entries into THAT
            // plugin's config.json; remove the Canopy/Elevate-namespaced ones.
            var pluginPagesConfigPath = Path.Combine(
                applicationPaths.PluginConfigurationsPath,
                "Jellyfin.Plugin.PluginPages",
                "config.json");
            CleanupRetiredPluginPagesCore(
                pluginPagesConfigPath,
                msg => _logger.LogInformation(msg),
                msg => _logger.LogError(msg));
        }

        // Marker → the legacy per-page ownership flag that recorded whether CANOPY
        // created the tab. An admin following the old manual instructions could have
        // pasted the SAME current-name marker by hand (JeOwned=false) — those tabs are
        // the admin's and stay (dead, but theirs to delete). Legacy "jellyfinelevate"
        // markers are removed unconditionally: only pre-2.0 builds wrote them and the
        // rename-era migrations already treat that identity as fully Canopy-owned.
        private static readonly Dictionary<string, string?> CustomTabMarkerOwnershipFlag = new(StringComparer.Ordinal)
        {
            ["<div class=\"sections bookmarks\"></div>"] = "BookmarksCustomTabJeOwned",
            ["<div class=\"jellyfincanopy hidden-content\"></div>"] = "HiddenContentCustomTabJeOwned",
            ["<div class=\"jellyfinelevate hidden-content\"></div>"] = null,
            ["<div class=\"jellyfincanopy requests\"></div>"] = "DownloadsCustomTabJeOwned",
            ["<div class=\"jellyfinelevate requests\"></div>"] = null,
            ["<div class=\"jellyfincanopy calendar\"></div>"] = "CalendarCustomTabJeOwned",
            ["<div class=\"jellyfinelevate calendar\"></div>"] = null,
        };

        // Static core, unit-testable against plain temp files. Removes the Custom Tabs
        // entries CANOPY created (per the *CustomTabJeOwned ownership flags, persisted
        // as hidden migration state on PluginConfiguration until this succeeds) plus
        // all legacy-Elevate markers, in place. Admin-created tabs that merely reuse a
        // current marker are preserved. Returns true on success OR a clean no-op;
        // false only when a present file could not be processed (the caller then
        // KEEPS the ownership flags so the cleanup retries next startup).
        internal static bool CleanupManagedCustomTabsCore(string customTabsConfigPath, IReadOnlySet<string> ownedFlags, Action<string> logInfo, Action<string> logError)
        {
            try
            {
                if (!File.Exists(customTabsConfigPath))
                {
                    return true;
                }

                var document = System.Xml.Linq.XDocument.Load(customTabsConfigPath, System.Xml.Linq.LoadOptions.PreserveWhitespace);

                // <PluginConfiguration><Tabs><TabConfig><ContentHtml>…</ContentHtml>…
                // Match by the ContentHtml element (XDocument decodes the escaped markup
                // back to the raw marker string) and remove its owning tab element.
                var removableTabs = document.Descendants()
                    .Where(e => string.Equals(e.Name.LocalName, "ContentHtml", StringComparison.Ordinal)
                        && CustomTabMarkerOwnershipFlag.TryGetValue(e.Value, out var flag)
                        && (flag == null || ownedFlags.Contains(flag)))
                    .Select(e => e.Parent)
                    .Where(parent => parent != null)
                    .Distinct()
                    .ToList();

                if (removableTabs.Count == 0)
                {
                    return true;
                }

                foreach (var tab in removableTabs)
                {
                    var name = tab!.Elements().FirstOrDefault(e => string.Equals(e.Name.LocalName, "Name", StringComparison.Ordinal))?.Value ?? "(unnamed)";
                    logInfo($"Removing the Canopy-created Custom Tabs entry '{name}' (retired delivery mode).");
                    tab.Remove();
                }

                using var buffer = new MemoryStream();
                document.Save(buffer);
                AtomicFile.WriteAllBytes(customTabsConfigPath, buffer.ToArray());
                logInfo($"Removed {removableTabs.Count} Jellyfin Canopy-owned Custom Tabs entr{(removableTabs.Count == 1 ? "y" : "ies")} left by the retired Custom-Tabs delivery mode.");
                return true;
            }
            catch (Exception ex)
            {
                logError($"Failed to clean up legacy Jellyfin Canopy Custom Tabs entries; leaving the Custom Tabs configuration untouched (will retry next startup): {ex.Message}");
                return false;
            }
        }

        // Removes the page entries the retired PluginPages integration wrote into that
        // external plugin's config.json. Every entry is namespace-attributable (its Id
        // is Canopy's — or pre-2.0 Elevate's — assembly namespace), so removal needs no
        // ownership state. Same idempotence/failure contract as the Custom Tabs core.
        internal static bool CleanupRetiredPluginPagesCore(string pluginPagesConfigPath, Action<string> logInfo, Action<string> logError)
        {
            try
            {
                if (!File.Exists(pluginPagesConfigPath))
                {
                    return true;
                }

                var root = JsonNode.Parse(File.ReadAllText(pluginPagesConfigPath));
                if (root?["Pages"] is not JsonArray pages)
                {
                    return true;
                }

                var namespaceName = typeof(JellyfinCanopy).Namespace!;
                var removed = 0;
                for (var i = pages.Count - 1; i >= 0; i--)
                {
                    var id = (string?)pages[i]?["Id"];
                    if (id != null
                        && (string.Equals(id, namespaceName, StringComparison.Ordinal)
                            || id.StartsWith(namespaceName + ".", StringComparison.Ordinal)
                            || string.Equals(id, LegacyAssemblyName, StringComparison.Ordinal)
                            || id.StartsWith(LegacyAssemblyName + ".", StringComparison.Ordinal)))
                    {
                        pages.RemoveAt(i);
                        removed++;
                    }
                }

                if (removed == 0)
                {
                    return true;
                }

                AtomicFile.WriteAllText(pluginPagesConfigPath, root.ToJsonString(new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
                logInfo($"Removed {removed} retired Jellyfin Canopy page entr{(removed == 1 ? "y" : "ies")} from the Plugin Pages configuration.");
                return true;
            }
            catch (Exception ex)
            {
                logError($"Failed to clean up retired Jellyfin Canopy Plugin Pages entries; leaving that configuration untouched (will retry next startup): {ex.Message}");
                return false;
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
    }
}