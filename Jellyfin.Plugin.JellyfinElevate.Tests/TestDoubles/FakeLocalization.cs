using System;
using System.Collections.Generic;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;

namespace Jellyfin.Plugin.JellyfinElevate.Tests.TestDoubles;

/// <summary>
/// Minimal <see cref="ILocalizationManager"/> fake with a fixed US rating→score
/// table (superset of both former nested copies). Extracted from
/// SeerrParentalFilterTests / ArrRequestsControllerParentalTests so every
/// parental suite shares one copy.
/// </summary>
public sealed class FakeLocalization : ILocalizationManager
{
    private static readonly Dictionary<string, ParentalRatingScore> Scores = new(StringComparer.OrdinalIgnoreCase)
    {
        ["G"] = new ParentalRatingScore(0, 0),
        ["PG"] = new ParentalRatingScore(10, 0),
        ["TV-PG"] = new ParentalRatingScore(10, 0),
        ["PG-13"] = new ParentalRatingScore(13, 0),
        ["TV-14"] = new ParentalRatingScore(14, 0),
        ["R"] = new ParentalRatingScore(17, 0),
        ["TV-MA"] = new ParentalRatingScore(17, 1),
        ["NC-17"] = new ParentalRatingScore(17, 1),
    };

    public ParentalRatingScore? GetRatingScore(string rating, string? countryCode = null)
        => Scores.TryGetValue(rating, out var score) ? score : null;

    public IEnumerable<CultureDto> GetCultures() => throw new NotImplementedException();

    public IReadOnlyList<CountryInfo> GetCountries() => throw new NotImplementedException();

    public IReadOnlyList<ParentalRating> GetParentalRatings() => throw new NotImplementedException();

    public string GetLocalizedString(string phrase, string culture) => throw new NotImplementedException();

    public string GetLocalizedString(string phrase) => throw new NotImplementedException();

    public string GetServerLocalizedString(string phrase) => throw new NotImplementedException();

    public IEnumerable<LocalizationOption> GetLocalizationOptions() => throw new NotImplementedException();

    public CultureDto? FindLanguageInfo(string language) => throw new NotImplementedException();

    public bool TryGetISO6392TFromB(string isoB, [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out string? isoT) => throw new NotImplementedException();
}
