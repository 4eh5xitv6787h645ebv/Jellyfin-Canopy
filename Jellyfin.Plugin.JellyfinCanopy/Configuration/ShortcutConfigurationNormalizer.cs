namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    /// <summary>
    /// Normalizes XmlSerializer's constructor-plus-persisted shortcut list.
    /// Named empty keys are intentional disabled state; the last named row wins.
    /// </summary>
    internal static class ShortcutConfigurationNormalizer
    {
        internal sealed record Result(
            List<Shortcut> Shortcuts,
            int DuplicatesDropped,
            int MalformedDropped,
            int NullKeysNormalized,
            IReadOnlyList<Shortcut> MissingDefaults)
        {
            internal bool Changed => DuplicatesDropped > 0
                || MalformedDropped > 0
                || NullKeysNormalized > 0
                || MissingDefaults.Count > 0;
        }

        internal static Result Normalize(
            IReadOnlyList<Shortcut?> shortcuts,
            IReadOnlyList<Shortcut> defaults)
        {
            ArgumentNullException.ThrowIfNull(shortcuts);
            ArgumentNullException.ThrowIfNull(defaults);

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var reversed = new List<Shortcut>(shortcuts.Count);
            var duplicates = 0;
            var malformed = 0;
            var normalizedNullKeys = 0;

            // XmlSerializer appends persisted rows to constructor defaults. Walk
            // backwards so the persisted/last row is authoritative, including
            // an empty key that deliberately disables the action.
            for (var index = shortcuts.Count - 1; index >= 0; index--)
            {
                var shortcut = shortcuts[index];
                if (shortcut == null || string.IsNullOrEmpty(shortcut.Name))
                {
                    malformed++;
                    continue;
                }

                if (!seen.Add(shortcut.Name))
                {
                    duplicates++;
                    continue;
                }

                if (shortcut.Key == null)
                {
                    shortcut = new Shortcut
                    {
                        Name = shortcut.Name,
                        Key = string.Empty,
                        Label = shortcut.Label,
                        Category = shortcut.Category,
                        ExtensionData = PersistedPayloadPolicy.CloneExtensionData(shortcut.ExtensionData)
                    };
                    normalizedNullKeys++;
                }

                reversed.Add(shortcut);
            }

            reversed.Reverse();
            var normalized = new List<Shortcut>(reversed.Count + defaults.Count);
            normalized.AddRange(reversed);
            var missing = new List<Shortcut>();
            foreach (var defaultShortcut in defaults)
            {
                if (string.IsNullOrEmpty(defaultShortcut.Name) || !seen.Add(defaultShortcut.Name))
                {
                    continue;
                }

                missing.Add(defaultShortcut);
                normalized.Add(defaultShortcut);
            }

            return new Result(normalized, duplicates, malformed, normalizedNullKeys, missing);
        }
    }
}
