namespace Jellyfin.Plugin.JellyfinCanopy.Model
{
    /// <summary>
    /// Caller-scoped language evidence for one Series or Season. This DTO is created
    /// per response and is never persisted in the shared tag cache.
    /// </summary>
    public sealed class TagLanguageCoverage
    {
        /// <summary>Accessible, real Episodes when traversal completed; otherwise null.</summary>
        public int? EligibleEpisodeCount { get; init; }

        /// <summary>Eligible Episodes whose current stream evidence was authoritative.</summary>
        public int? ObservedEpisodeCount { get; init; }

        /// <summary>True only when traversal and every eligible Episode probe were complete.</summary>
        public bool Complete { get; init; }

        /// <summary>Languages proven present in every eligible Episode.</summary>
        public string[] FullLanguages { get; init; } = System.Array.Empty<string>();

        /// <summary>Languages proven present in some, but absent from another observed Episode.</summary>
        public string[] PartialLanguages { get; init; } = System.Array.Empty<string>();

        /// <summary>Observed languages whose full/partial status is unresolved.</summary>
        public string[] UnknownLanguages { get; init; } = System.Array.Empty<string>();

        /// <summary>True when traversal or the bounded language list was truncated.</summary>
        public bool Truncated { get; init; }

        /// <summary>Accessible language identities omitted by the response cap, when known.</summary>
        public int? OmittedLanguageCount { get; init; }
    }
}
