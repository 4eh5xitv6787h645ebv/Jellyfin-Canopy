namespace Jellyfin.Plugin.JellyfinCanopy.Services
{
    /// <summary>
    /// Owns the rating-pair inheritance contract used by full builds and every
    /// incremental parent-Series repair path.
    /// </summary>
    internal static class TagCacheRatingInheritance
    {
        /// <summary>
        /// Returns true only when neither child rating exists. A valid zero or
        /// single-digit critic percentage is owned data and must be preserved.
        /// </summary>
        internal static bool ShouldInherit(float? communityRating, float? criticRating)
            => communityRating == null && criticRating == null;
    }
}
