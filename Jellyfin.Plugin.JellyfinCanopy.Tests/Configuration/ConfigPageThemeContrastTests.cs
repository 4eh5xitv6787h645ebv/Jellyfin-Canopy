using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Theme-contrast guard for the config page stylesheet. The Canopy card
    /// surface flips light/dark with the page's theme detector, so any rule
    /// that paints a near-white FOREGROUND with a literal hex goes unreadable
    /// the moment its background flips light. Every theme-flipping surface
    /// must use the --jc-text-*/--jc-on-accent tokens; literal light
    /// foregrounds are only legal on surfaces this sheet pins dark forever
    /// (brand-gradient fills, the intentionally-dark preview/toast overlays).
    /// </summary>
    public class ConfigPageThemeContrastTests
    {
        // Literal light AND mid-gray foregrounds: hex shorthands/full forms from
        // #888 up, plus any rgba() whose channels are all ≥ 200 — both families
        // vanish on the light card surface (and mid-grays fail on both themes).
        private static readonly Regex LightForeground = new(
            @"(?<!background-)color:\s*(?:#(?:fff(?:fff)?|f5f5f5|e8e8e8|e0e0e0|eee(?:eee)?|d0d0d0|ddd(?:ddd)?|ccc(?:ccc)?|bbb(?:bbb)?|aaa(?:aaa)?|999(?:999)?|888(?:888)?)\b|rgba?\(\s*2[0-9]{2}\s*,\s*2[0-9]{2}\s*,\s*2[0-9]{2})",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

        // Selectors whose background is hard-pinned dark in the same sheet,
        // independent of the theme class.
        private static readonly Regex AlwaysDarkContext = new(
            string.Join("|", new[]
            {
                @"\.jellyfin-tab-button\.active",   // brand gradient fill
                @"\.jc-save-dock-btn",              // brand gradient fill
                @"\.jc-branding-delete",            // white glyph on a dark scrim OVER a user image (theme-independent)
                @"\.jc-preview-panel-card",         // background: rgb(24, 24, 24)
                @"\.jc-preview-toast",              // dark gradient toast
                @"\.jc-update-toast",               // dark gradient toast
            }),
            RegexOptions.Compiled);

        [Fact]
        public void LightLiteralForegroundsOnlyAppearOnAlwaysDarkSurfaces()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));

            // Walk rule blocks: selector text is everything between '}' and '{'.
            var offenders = new List<string>();
            foreach (Match block in Regex.Matches(css, @"(?<selector>[^{}]+)\{(?<body>[^{}]*)\}"))
            {
                var body = block.Groups["body"].Value;
                if (!LightForeground.IsMatch(body))
                {
                    continue;
                }

                var selector = block.Groups["selector"].Value.Trim();
                if (!AlwaysDarkContext.IsMatch(selector))
                {
                    offenders.Add(selector.Replace('\n', ' '));
                }
            }

            Assert.True(
                offenders.Count == 0,
                "these selectors paint a literal light foreground on a theme-flipping surface — use var(--jc-text-strong)/var(--jc-text-muted)/var(--jc-on-accent) instead:\n"
                + string.Join("\n", offenders));
        }

        private static string ConfigurationDirectory()
        {
            var dir = AppContext.BaseDirectory;
            while (dir != null && !Directory.Exists(Path.Combine(dir, "Jellyfin.Plugin.JellyfinCanopy", "Configuration")))
            {
                dir = Path.GetDirectoryName(dir);
            }

            Assert.False(dir == null, "could not locate the repository root from the test base directory");
            return Path.Combine(dir!, "Jellyfin.Plugin.JellyfinCanopy", "Configuration");
        }
    }
}
