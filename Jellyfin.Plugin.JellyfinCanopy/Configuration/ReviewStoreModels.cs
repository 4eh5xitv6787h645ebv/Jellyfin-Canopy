using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Configuration
{
    internal static class ReviewLimits
    {
        public const int ContentCharacters = 2000;
        public const int RequestBytes = 16 * 1024;
        public const int DefaultPageSize = 50;
        public const int MaximumPageSize = 100;
        public const int PerUserReviews = 1000;
        public const int TotalReviews = 15000;
        public const long LegacyJsonBytes = 128L * 1024 * 1024;
        public const int RetainedBackups = 5;

        public static bool IsContentWithinLimit(string content)
            => content.Length <= ContentCharacters;
    }

    internal sealed class ReviewPage
    {
        public ReviewPage(IReadOnlyList<UserReview> reviews, string? nextCursor)
        {
            Reviews = reviews;
            NextCursor = nextCursor;
        }

        public IReadOnlyList<UserReview> Reviews { get; }

        public string? NextCursor { get; }
    }

    internal sealed class ReviewStoreStatus
    {
        public long TotalReviews { get; init; }

        public int PerUserLimit => ReviewLimits.PerUserReviews;

        public int TotalLimit => ReviewLimits.TotalReviews;

        public bool LegacyQuotaExceeded => TotalReviews > ReviewLimits.TotalReviews;
    }

    internal enum ReviewUpsertOutcome
    {
        Created,
        Updated
    }

    internal sealed class ReviewQuotaExceededException : InvalidOperationException
    {
        public ReviewQuotaExceededException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; }
    }

    internal sealed class ReviewStoreUnavailableException : InvalidOperationException
    {
        public ReviewStoreUnavailableException(string message, Exception? innerException = null)
            : base(message, innerException)
        {
        }
    }
}
