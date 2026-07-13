using System.Text.RegularExpressions;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Theme-contrast guard for the config page stylesheet. The Canopy card
    /// surface flips light/dark with the page's theme detector, so any rule
    /// that paints a NEUTRAL bright foreground (white or gray, carrying no
    /// hue) with a literal value goes unreadable the moment its background
    /// flips light. Every theme-flipping neutral foreground must use the
    /// --jc-text-*/--jc-on-accent tokens. Hue-carrying status colors (the
    /// green/amber/red state accents) are exempt: they are semantic, sit on
    /// tinted chips/rails, and read on both themes. Literal neutral brights
    /// stay legal only on surfaces this sheet pins dark forever.
    /// </summary>
    public class ConfigPageThemeContrastTests
    {
        private static readonly Regex ForegroundDeclaration = new(
            @"(?<!background-|-left-|-right-|-top-|-bottom-|border-|outline-)color:\s*(?<value>#[0-9a-fA-F]{3,8}|rgba?\([^)]+\))",
            RegexOptions.Compiled);

        // Selectors whose background is hard-pinned dark in the same sheet,
        // independent of the theme class.
        private static readonly Regex AlwaysDarkContext = new(
            string.Join("|", new[]
            {
                @"\.jellyfin-tab-button\.active",   // brand gradient fill
                @"\.jc-save-dock-btn",              // brand gradient fill
                @"\.jc-nav-toggle",                 // brand gradient fill (mobile drawer pill)
                @"\.jc-branding-delete",            // white glyph on a dark scrim OVER a user image (theme-independent)
                @"\.jc-preview-panel-card",         // background: rgb(24, 24, 24)
                @"\.jc-preview-toast",              // dark gradient toast
                @"\.jc-update-toast",               // dark gradient toast
            }),
            RegexOptions.Compiled);

        [Fact]
        public void NeutralBrightLiteralForegroundsOnlyAppearOnAlwaysDarkSurfaces()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));

            var offenders = new List<string>();
            foreach (Match block in Regex.Matches(css, @"(?<selector>[^{}]+)\{(?<body>[^{}]*)\}"))
            {
                var body = block.Groups["body"].Value;
                var flagged = false;
                foreach (Match declaration in ForegroundDeclaration.Matches(body))
                {
                    if (TryParseColor(declaration.Groups["value"].Value, out var r, out var g, out var b)
                        && IsNeutralBright(r, g, b))
                    {
                        flagged = true;
                        break;
                    }
                }

                if (!flagged)
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
                "these selectors paint a literal neutral-bright foreground on a theme-flipping surface — use var(--jc-text-strong)/var(--jc-text-muted)/var(--jc-on-accent) instead:\n"
                + string.Join("\n", offenders));
        }

        private static bool TryParseColor(string value, out int r, out int g, out int b)
        {
            r = g = b = 0;
            if (value.StartsWith('#'))
            {
                var hex = value[1..];
                if (hex.Length == 3 || hex.Length == 4)
                {
                    r = Convert.ToInt32(new string(hex[0], 2), 16);
                    g = Convert.ToInt32(new string(hex[1], 2), 16);
                    b = Convert.ToInt32(new string(hex[2], 2), 16);
                    return true;
                }

                if (hex.Length == 6 || hex.Length == 8)
                {
                    r = Convert.ToInt32(hex[..2], 16);
                    g = Convert.ToInt32(hex[2..4], 16);
                    b = Convert.ToInt32(hex[4..6], 16);
                    return true;
                }

                return false;
            }

            var channels = Regex.Matches(value, @"[\d.]+");
            if (channels.Count < 3)
            {
                return false;
            }

            r = (int)double.Parse(channels[0].Value);
            g = (int)double.Parse(channels[1].Value);
            b = (int)double.Parse(channels[2].Value);
            return true;
        }

        /// <summary>
        /// Bright (relative luminance > 0.45) AND essentially hueless
        /// (max−min channel spread below 60): whites and grays that vanish on
        /// the light card surface. Saturated status hues pass.
        /// </summary>
        private static bool IsNeutralBright(int r, int g, int b)
        {
            var luminance = ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255.0;
            var spread = Math.Max(r, Math.Max(g, b)) - Math.Min(r, Math.Min(g, b));
            return luminance > 0.45 && spread < 60;
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
