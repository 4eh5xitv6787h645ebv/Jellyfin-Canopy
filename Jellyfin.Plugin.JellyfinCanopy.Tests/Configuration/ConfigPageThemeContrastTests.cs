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

        // Selectors whose dark backing the block parser below cannot verify
        // (gradients, scrims over images, or backing declared in a different
        // block). A rule that pins its OWN background to a literal solid dark
        // color needs no entry here — HasVerifiedDarkBackground proves it.
        private static readonly Regex AlwaysDarkContext = new(
            string.Join("|", new[]
            {
                @"\.jellyfin-tab-button\.active",   // brand gradient fill
                @"\.jc-save-dock-btn",              // brand gradient fill
                @"\.jc-branding-delete",            // white glyph on a dark scrim OVER a user image (theme-independent)
                @"\.jc-preview-panel-card",         // background: rgb(24, 24, 24), bright text in descendant blocks
                @"\.jc-preview-toast",              // dark gradient toast
                @"\.jc-update-toast",               // dark gradient toast
            }),
            RegexOptions.Compiled);

        private static readonly Regex SolidBackgroundDeclaration = new(
            @"background(?:-color)?:\s*(?<value>#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b|rgb\([^)]+\))",
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
                if (!AlwaysDarkContext.IsMatch(selector) && !HasVerifiedDarkBackground(body))
                {
                    offenders.Add(selector.Replace('\n', ' '));
                }
            }

            Assert.True(
                offenders.Count == 0,
                "these selectors paint a literal neutral-bright foreground on a theme-flipping surface — use var(--jc-text-strong)/var(--jc-text-muted)/var(--jc-on-accent) instead:\n"
                + string.Join("\n", offenders));
        }

        [Fact]
        public void SemanticPaletteMeetsContrastOnEveryOwnedSurface()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));
            var dark = ExtractPalette(css, "#JellyfinCanopyPage");
            var light = new Dictionary<string, string>(dark, StringComparer.Ordinal);
            foreach (var (token, value) in ExtractPalette(css, "#JellyfinCanopyPage.jc-light-theme"))
            {
                light[token] = value;
            }

            var palettes = new[]
            {
                (Name: "dark", Values: dark),
                (Name: "light", Values: light),
            };
            var foregrounds = new[]
            {
                "jc-text-strong", "jc-text-muted", "jc-text-subtle", "jc-text-dim",
                "jc-accent", "jc-success", "jc-warning", "jc-danger", "jc-info",
            };
            var surfaces = new[] { "jc-card-bg", "jc-surface-1", "jc-surface-2", "jc-surface-3" };

            foreach (var palette in palettes)
            {
                foreach (var foreground in foregrounds)
                {
                    foreach (var surface in surfaces)
                    {
                        AssertContrast(palette.Name, palette.Values, foreground, surface, 4.5);
                    }
                }

                foreach (var surface in surfaces)
                {
                    AssertContrast(palette.Name, palette.Values, "jc-border-focus", surface, 3.0);
                }

                AssertContrast(palette.Name, palette.Values, "jc-on-accent", "jc-accent", 4.5);
                foreach (var stop in new[] { "jc-control-start", "jc-control-mid", "jc-control-end" })
                {
                    AssertContrast(palette.Name, palette.Values, "jc-control-text", stop, 4.5);
                }
            }
        }

        [Fact]
        public void LightPreferenceFallbackDefinesTheCompletePairedPalette()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));
            var light = PaletteDeclarations(css, "#JellyfinCanopyPage.jc-light-theme");
            var fallback = Regex.Match(
                css,
                @"#JellyfinCanopyPage:not\(\.jc-dark-theme\):not\(\.jc-light-theme\)\s*\{(?<body>[^{}]+)\}");
            Assert.True(fallback.Success, "light-preference fallback palette was not found");
            var fallbackDeclarations = DeclarationValues(fallback.Groups["body"].Value);

            Assert.NotEmpty(light);
            Assert.Equal(light.Keys.OrderBy(token => token), fallbackDeclarations.Keys.OrderBy(token => token));
            foreach (var (token, expected) in light)
            {
                Assert.True(fallbackDeclarations.TryGetValue(token, out var actual), $"fallback misses --{token}");
                Assert.Equal(expected, actual);
            }
        }

        [Fact]
        public void ThemeDetectorTrustsJellyfinsExplicitLightIdentityBeforeColorSampling()
        {
            var js = ConfigPageSource.Js;
            var declaredTheme = js.IndexOf("getAttribute('data-theme')", StringComparison.Ordinal);
            var explicitLight = js.IndexOf("declaredTheme === 'light'", StringComparison.Ordinal);
            var backgroundSampling = js.IndexOf("var candidates =", StringComparison.Ordinal);

            Assert.True(declaredTheme >= 0, "theme detector does not read Jellyfin's data-theme identity");
            Assert.True(explicitLight > declaredTheme, "theme detector does not recognize Jellyfin's Light theme");
            Assert.True(
                backgroundSampling > explicitLight,
                "theme detector must trust Jellyfin's explicit Light identity before sampling transparent host surfaces");
        }

        [Fact]
        public void EveryInteractiveAdminControlHasAnOwnedVisibleFocusRing()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));
            var rule = Regex.Match(
                css,
                @"#JellyfinCanopyPage\s+:is\((?<selectors>[^{}]+)\):focus-visible\s*\{(?<body>[^{}]+)\}");
            Assert.True(rule.Success, "scoped interactive focus-visible rule was not found");
            foreach (var selector in new[] { "button", "a[href]", "input", "select", "textarea", "[tabindex]" })
            {
                Assert.Contains(selector, rule.Groups["selectors"].Value, StringComparison.Ordinal);
            }

            Assert.Matches(@"outline:\s*3px\s+solid\s+var\(--jc-border-focus\)", rule.Groups["body"].Value);
            Assert.Matches(@"outline-offset:\s*3px", rule.Groups["body"].Value);
        }

        [Fact]
        public void DisabledDashboardRowsRemainLegibleInsteadOfBeingWashedOut()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));
            foreach (var selector in new[] { @"\.jc-service-card\.jc-state-off", @"\.jc-feature-row\.jc-state-off" })
            {
                var rule = Regex.Match(css, $@"{selector}[^{{}}]*\{{(?<body>[^{{}}]+)\}}");
                Assert.True(rule.Success, $"disabled-state rule {selector} was not found");
                var opacity = Regex.Match(rule.Groups["body"].Value, @"opacity:\s*(?<value>\d+(?:\.\d+)?)");
                Assert.True(opacity.Success, $"disabled-state rule {selector} has no explicit opacity");
                Assert.Equal(
                    1,
                    double.Parse(opacity.Groups["value"].Value, System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        [Fact]
        public void SelectChevronConsumesThePairedThemePalette()
        {
            var css = File.ReadAllText(Path.Combine(ConfigurationDirectory(), "configPage.css"));
            Assert.Matches(
                @"#JellyfinCanopyPage select\.emby-select\s*\{[^{}]*background-image:\s*var\(--jc-select-chevron\)",
                css);
            Assert.Matches(
                @"#JellyfinCanopyPage select\.emby-select:focus,[^{}]*\{[^{}]*background-image:\s*var\(--jc-select-chevron-focus\)",
                css);
        }

        private static Dictionary<string, string> ExtractPalette(string css, string selector)
        {
            foreach (Match block in Regex.Matches(css, @"(?<selector>[^{}]+)\{(?<body>[^{}]*)\}"))
            {
                var selectorText = Regex.Replace(
                    block.Groups["selector"].Value,
                    @"/\*.*?\*/",
                    string.Empty,
                    RegexOptions.Singleline).Trim();
                if (!string.Equals(selectorText, selector, StringComparison.Ordinal)
                    || !block.Groups["body"].Value.Contains("--jc-card-bg", StringComparison.Ordinal))
                {
                    continue;
                }

                return Regex.Matches(
                        block.Groups["body"].Value,
                        @"--(?<name>[a-z0-9-]+)\s*:\s*(?<value>#[0-9a-fA-F]{6}|var\(--[a-z0-9-]+\))\s*;")
                    .ToDictionary(
                        declaration => declaration.Groups["name"].Value,
                        declaration => declaration.Groups["value"].Value,
                        StringComparer.Ordinal);
            }

            throw new Xunit.Sdk.XunitException($"palette block {selector} was not found");
        }

        private static Dictionary<string, string> PaletteDeclarations(string css, string selector)
        {
            var block = Regex.Match(
                css,
                $@"{Regex.Escape(selector)}\s*\{{(?<body>[^{{}}]+)\}}");
            Assert.True(block.Success, $"palette block {selector} was not found");
            return DeclarationValues(block.Groups["body"].Value);
        }

        private static Dictionary<string, string> DeclarationValues(string body)
        {
            return Regex.Matches(
                    body,
                    @"^[ \t]*--(?<name>[a-z0-9-]+)\s*:\s*(?<value>.+);\s*$",
                    RegexOptions.Multiline)
                .ToDictionary(
                    declaration => declaration.Groups["name"].Value,
                    declaration => declaration.Groups["value"].Value.Trim(),
                    StringComparer.Ordinal);
        }

        private static void AssertContrast(
            string paletteName,
            IReadOnlyDictionary<string, string> palette,
            string foregroundToken,
            string backgroundToken,
            double minimum)
        {
            var foreground = ResolveToken(paletteName, palette, foregroundToken);
            var background = ResolveToken(paletteName, palette, backgroundToken);
            var ratio = ContrastRatio(foreground, background);
            Assert.True(
                ratio >= minimum,
                $"{paletteName} --{foregroundToken} ({foreground}) on --{backgroundToken} ({background}) "
                + $"has {ratio:F2}:1 contrast; expected at least {minimum:F1}:1");
        }

        private static string ResolveToken(
            string paletteName,
            IReadOnlyDictionary<string, string> palette,
            string token,
            HashSet<string>? visited = null)
        {
            Assert.True(palette.TryGetValue(token, out var value), $"{paletteName} misses --{token}");
            if (value!.StartsWith('#'))
            {
                return value;
            }

            var reference = Regex.Match(value, @"^var\(--(?<name>[a-z0-9-]+)\)$");
            Assert.True(reference.Success, $"{paletteName} --{token} is not a resolvable solid color: {value}");
            visited ??= new HashSet<string>(StringComparer.Ordinal);
            Assert.True(visited.Add(token), $"{paletteName} palette contains a variable cycle at --{token}");
            return ResolveToken(paletteName, palette, reference.Groups["name"].Value, visited);
        }

        private static double ContrastRatio(string foreground, string background)
        {
            var foregroundLuminance = RelativeLuminance(foreground);
            var backgroundLuminance = RelativeLuminance(background);
            return (Math.Max(foregroundLuminance, backgroundLuminance) + 0.05)
                / (Math.Min(foregroundLuminance, backgroundLuminance) + 0.05);
        }

        private static double RelativeLuminance(string hex)
        {
            var channels = new[]
            {
                Convert.ToInt32(hex[1..3], 16) / 255.0,
                Convert.ToInt32(hex[3..5], 16) / 255.0,
                Convert.ToInt32(hex[5..7], 16) / 255.0,
            };
            var linear = channels.Select(channel => channel <= 0.04045
                ? channel / 12.92
                : Math.Pow((channel + 0.055) / 1.055, 2.4)).ToArray();
            return (0.2126 * linear[0]) + (0.7152 * linear[1]) + (0.0722 * linear[2]);
        }

        /// <summary>
        /// True when the block pins its own background to a literal, opaque,
        /// dark color (simple luminance below 0.2 — comfortably darker than
        /// white text needs). Gradients, tokens, and alpha colors never
        /// qualify, so reverting such a surface to the brand gradient makes
        /// its bright foreground an offender again.
        /// </summary>
        private static bool HasVerifiedDarkBackground(string body)
        {
            foreach (Match declaration in SolidBackgroundDeclaration.Matches(body))
            {
                if (TryParseColor(declaration.Groups["value"].Value, out var r, out var g, out var b)
                    && ((0.2126 * r) + (0.7152 * g) + (0.0722 * b)) / 255.0 < 0.2)
                {
                    return true;
                }
            }

            return false;
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
