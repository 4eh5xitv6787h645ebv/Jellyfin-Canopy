using System;
using System.Globalization;
using System.Linq;
using Jellyfin.Plugin.JellyfinCanopy.Helpers.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Model.Seerr;
using Jellyfin.Plugin.JellyfinCanopy.Platform.Hosting;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Seerr
{
    /// <summary>The exact installed-item media kinds understood by the Seerr owners.</summary>
    internal enum SeerrMediaRequestKind
    {
        Movie,
        Series,
    }

    /// <summary>
    /// A server-derived Seerr target. It is internal so no wire caller can mint
    /// provider identity or select a generic upstream path.
    /// </summary>
    internal readonly record struct SeerrMediaTarget(
        SeerrMediaRequestKind Kind,
        int TmdbId,
        string MediaType);

    /// <summary>Shared exact-target and permission rules for read and mutation owners.</summary>
    internal static class SeerrMediaTargetPolicy
    {
        internal static bool TryProject(HostAccessibleItem item, out SeerrMediaTarget target)
        {
            target = default;
            if (item.Id == Guid.Empty
                || item.Kind is not (HostItemKind.Movie or HostItemKind.Series)
                || item.ProviderReferences.IsDefaultOrEmpty)
            {
                return false;
            }

            var tmdbValues = item.ProviderReferences
                .Where(reference => string.Equals(reference.Provider, "Tmdb", StringComparison.Ordinal))
                .Select(reference => reference.Value)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (tmdbValues.Length != 1
                || !int.TryParse(
                    tmdbValues[0],
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out var tmdbId)
                || tmdbId <= 0)
            {
                return false;
            }

            var kind = item.Kind == HostItemKind.Series
                ? SeerrMediaRequestKind.Series
                : SeerrMediaRequestKind.Movie;
            target = new SeerrMediaTarget(
                kind,
                tmdbId,
                kind == SeerrMediaRequestKind.Series ? "tv" : "movie");
            return true;
        }

        internal static bool HasPermission(
            SeerrPermission permissions,
            SeerrMediaRequestKind kind,
            SeerrMediaRequestVariant variant)
        {
            if (SeerrPermissionHelper.HasPermission(permissions, SeerrPermission.ADMIN))
            {
                return true;
            }

            if (variant == SeerrMediaRequestVariant.FourK)
            {
                return SeerrPermissionHelper.CanRequest4k(
                    permissions,
                    isTv: kind == SeerrMediaRequestKind.Series);
            }

            var mediaPermission = kind == SeerrMediaRequestKind.Series
                ? SeerrPermission.REQUEST_TV
                : SeerrPermission.REQUEST_MOVIE;
            return SeerrPermissionHelper.HasAnyPermission(
                permissions,
                SeerrPermission.REQUEST | mediaPermission);
        }
    }
}
