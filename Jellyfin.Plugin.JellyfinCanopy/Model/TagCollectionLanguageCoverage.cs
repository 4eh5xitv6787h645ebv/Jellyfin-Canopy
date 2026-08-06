namespace Jellyfin.Plugin.JellyfinCanopy.Model
{
    /// <summary>
    /// Caller-scoped audio-language coverage for the directly linked Movies in a collection.
    /// This is a response-only projection and is never persisted in the shared tag cache.
    /// </summary>
    public sealed class TagCollectionLanguageCoverage
    {
        public int? EligibleMemberCount { get; set; }

        public int? ObservedMemberCount { get; set; }

        public bool Complete { get; set; }

        public string[] FullLanguages { get; set; } = System.Array.Empty<string>();

        public string[] PartialLanguages { get; set; } = System.Array.Empty<string>();

        public string[] UnknownLanguages { get; set; } = System.Array.Empty<string>();

        public bool Truncated { get; set; }

        public int? OmittedLanguageCount { get; set; }
    }
}
