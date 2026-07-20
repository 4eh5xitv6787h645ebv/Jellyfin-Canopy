using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Jellyfin.Plugin.JellyfinCanopy.Configuration;
using Jellyfin.Plugin.JellyfinCanopy.Controllers;
using Xunit;

namespace Jellyfin.Plugin.JellyfinCanopy.Tests.Configuration
{
    /// <summary>
    /// Per-property guard proving every bool descriptor projected into public-config reads ITS
    /// OWN backing property. The golden distinctive-config flips every bool to !default, which
    /// surfaces a wrong-bool read only when the two properties have DIFFERENT defaults; this
    /// guard closes the same-default hole (both false→both true, invisible in the snapshot) by
    /// isolating each descriptor→property binding: flip exactly one bool property and assert
    /// that ONLY its own payload key moved.
    /// </summary>
    public class BoolProjectionGuardTests
    {
        // Public-config bool keys that are COMPUTED — their key is NOT a same-named bool
        // PluginConfiguration property, so they correctly fall outside the per-property guard
        // (a computed projection can't be isolated by flipping a single property).
        private static readonly HashSet<string> ComputedPublicBoolKeys = new(StringComparer.Ordinal)
        {
            "TmdbEnabled", // derived from TMDB_API_KEY (a string), not a bool property
            "SeerrConfigured",
            "SonarrConfigured",
            "RadarrConfigured",
            "BazarrConfigured",
        };

        [Fact]
        public void EachBoolDescriptorProjectsItsOwnProperty()
        {
            var boolProps = WritableBoolProperties();
            var boolKeys = BoolBackedPublicKeys(boolProps);

            // The ~40 Public/PublicUser bools — a zero here would mean the guard is inert.
            Assert.NotEmpty(boolKeys);

            var defaults = new PluginConfiguration();
            var defaultOf = boolKeys.ToDictionary(
                key => key,
                key => (bool)boolProps[key].GetValue(defaults)!,
                StringComparer.Ordinal);

            foreach (var key in boolKeys)
            {
                // Flip exactly ONE bool property to !default; every other bool stays default.
                var config = new PluginConfiguration();
                boolProps[key].SetValue(config, !defaultOf[key]);

                var payload = (IReadOnlyDictionary<string, object?>)
                    ConfigController.BuildPublicConfigPayload(config, isAuthed: true);

                // The flipped descriptor must read its OWN property …
                Assert.True(
                    payload.TryGetValue(key, out var flipped) && flipped is bool,
                    $"{key}: expected a bool value in public-config");
                Assert.Equal(!defaultOf[key], (bool)flipped!);

                // … and NOTHING ELSE moved — catches a descriptor that reads `key`'s property
                // instead of its own, even when the two share a default.
                foreach (var other in boolKeys.Where(k => !string.Equals(k, key, StringComparison.Ordinal)))
                {
                    Assert.True(
                        payload.TryGetValue(other, out var value) && value is bool,
                        $"{other}: expected a bool value in public-config");
                    Assert.True(
                        (bool)value! == defaultOf[other],
                        $"flipping {key} moved unrelated key {other} — a wrong-property bool read");
                }
            }
        }

        [Fact]
        public void ComputedBoolKeysAreNotBackedBySameNamedProperties()
        {
            var boolProps = WritableBoolProperties();
            var payload = (IReadOnlyDictionary<string, object?>)
                ConfigController.BuildPublicConfigPayload(new PluginConfiguration(), isAuthed: true);

            foreach (var key in ComputedPublicBoolKeys)
            {
                // It IS projected as a bool value …
                Assert.True(
                    payload.TryGetValue(key, out var value) && value is bool,
                    $"{key}: expected a computed bool in public-config");

                // … but has NO same-named bool property, so the per-property guard skips it.
                Assert.DoesNotContain(key, boolProps.Keys);
            }
        }

        private static Dictionary<string, PropertyInfo> WritableBoolProperties()
            => typeof(PluginConfiguration)
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .Where(p => p.CanWrite && p.PropertyType == typeof(bool))
                .ToDictionary(p => p.Name, p => p, StringComparer.Ordinal);

        private static IReadOnlyList<string> BoolBackedPublicKeys(Dictionary<string, PropertyInfo> boolProps)
            => SettingDescriptors.All
                .Where(d => d.Exposure is SettingExposure.Public or SettingExposure.Both)
                .Select(d => d.Key)
                .Where(boolProps.ContainsKey)
                .Distinct(StringComparer.Ordinal)
                .ToList();
    }
}
