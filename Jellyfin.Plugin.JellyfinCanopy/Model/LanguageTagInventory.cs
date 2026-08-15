namespace Jellyfin.Plugin.JellyfinCanopy.Model
{
    /// <summary>
    /// Bounded caller-scoped canonical audio-language choices. No item identifiers,
    /// counts, paths, or relationship information cross this projection boundary.
    /// </summary>
    public sealed class LanguageTagInventory
    {
        public string[] Languages { get; init; } = System.Array.Empty<string>();

        public bool Complete { get; init; }

        public bool Truncated { get; init; }
    }
}
