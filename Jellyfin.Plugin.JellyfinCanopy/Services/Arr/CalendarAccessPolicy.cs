using System;
using System.Collections.Generic;
using System.Linq;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using Jellyfin.Plugin.JellyfinCanopy.Data;
using Jellyfin.Plugin.JellyfinCanopy.Model.Arr;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.JellyfinCanopy.Services.Arr
{
    /// <summary>Three-valued calendar access result. Unknown is never silently treated as allowed.</summary>
    public enum CalendarAccessState
    {
        Unresolved,
        Inaccessible,
        Accessible
    }

    /// <summary>An authoritative root returned by one configured Arr instance.</summary>
    public sealed record ArrRootBinding(string InstanceKey, ItemLookupKind Kind, string RootPath);

    /// <summary>
    /// Resolves an Arr media path against Jellyfin's configured virtual folders and the user's
    /// explicit enabled/blocked-folder policy. Each result is keyed by media type and the stable
    /// Arr instance key so identical paths on different instances cannot lend each other access.
    /// </summary>
    public sealed class CalendarAccessPolicy
    {
        private readonly IReadOnlyList<VirtualFolderInfo> _folders;
        private readonly HashSet<Guid> _enabledFolderIds;
        private readonly HashSet<(string Instance, ItemLookupKind Kind, string Root)> _rootBindings;
        private readonly HashSet<(ItemLookupKind Kind, string Root)> _ambiguousRoots;
        private readonly Dictionary<(string Instance, ItemLookupKind Kind, string Path), CalendarAccessState> _cache = new();

        public CalendarAccessPolicy(
            IReadOnlyList<VirtualFolderInfo> folders,
            JUser user,
            IReadOnlyCollection<ArrRootBinding> rootBindings)
        {
            _folders = folders;

            var allFolderIds = folders
                .Select(folder => Guid.TryParse(folder.ItemId, out var id) ? id : Guid.Empty)
                .Where(id => id != Guid.Empty)
                .ToHashSet();
            var blocked = user.GetPreferenceValues<Guid>(PreferenceKind.BlockedMediaFolders).ToHashSet();

            if (blocked.Count > 0)
            {
                _enabledFolderIds = allFolderIds.Where(id => !blocked.Contains(id)).ToHashSet();
            }
            else if (user.HasPermission(PermissionKind.EnableAllFolders))
            {
                _enabledFolderIds = allFolderIds;
            }
            else
            {
                _enabledFolderIds = user.GetPreferenceValues<Guid>(PreferenceKind.EnabledFolders).ToHashSet();
            }

            // Bind roots from each Arr instance's authoritative /rootfolder response, never from
            // whichever calendar events happened to appear in this date window.
            _rootBindings = rootBindings
                .Where(binding => TryNormalizePath(binding.RootPath, out _))
                .Select(binding => (
                    binding.InstanceKey,
                    binding.Kind,
                    Root: NormalizePath(binding.RootPath)))
                .ToHashSet();

            // A literal root path is not an authority boundary across independent Arr hosts. When
            // several hosts claim the same typed path and there is no explicit mount mapping, fail
            // unresolved instead of allowing either host to borrow the other's access.
            _ambiguousRoots = _rootBindings
                .GroupBy(binding => (binding.Kind, binding.Root))
                .Where(group => group.Select(binding => binding.Instance).Distinct(StringComparer.Ordinal).Count() > 1)
                .Select(group => group.Key)
                .ToHashSet();
        }

        public CalendarAccessState Resolve(ArrItem item, ItemLookupKind expectedKind)
        {
            if (!TryGetBoundRoot(item, expectedKind, out var normalizedPath, out _))
                return CalendarAccessState.Unresolved;

            var key = BuildCacheKey(item.ArrInstanceKey, expectedKind, normalizedPath);
            if (_cache.TryGetValue(key, out var cached))
                return cached;

            var folderMatches = _folders
                .Where(folder => IsCompatible(folder.CollectionType, expectedKind))
                .SelectMany(folder => (folder.Locations ?? Array.Empty<string>())
                    .Where(location => TryNormalizePath(location, out var normalizedLocation)
                        && IsWithin(normalizedPath, normalizedLocation))
                    .Select(location => (
                        Folder: folder,
                        Length: NormalizePath(location).Length)))
                .ToList();
            var mostSpecificLength = folderMatches.Count == 0
                ? -1
                : folderMatches.Max(match => match.Length);
            var matchingFolders = folderMatches
                .Where(match => match.Length == mostSpecificLength)
                .Select(match => match.Folder)
                .DistinctBy(folder => folder.ItemId)
                .ToList();

            CalendarAccessState state;
            if (matchingFolders.Count == 0)
            {
                state = CalendarAccessState.Unresolved;
            }
            else if (matchingFolders.Any(folder => Guid.TryParse(folder.ItemId, out var id) && _enabledFolderIds.Contains(id)))
            {
                state = CalendarAccessState.Accessible;
            }
            else
            {
                state = CalendarAccessState.Inaccessible;
            }

            _cache[key] = state;
            return state;
        }

        /// <summary>
        /// Correlates one Jellyfin candidate with this exact Arr event. Provider IDs alone are
        /// global and cannot establish instance/root ownership. Main items require an exact media
        /// path (or a file below a movie folder); episode files must be descendants of the exact
        /// series path. Missing and ambiguous authoritative Arr roots never correlate.
        /// </summary>
        public bool Correlates(ArrItem item, ItemLookupCandidate candidate, ItemLookupKind expectedKind)
        {
            if (candidate.Kind != expectedKind
                || !TryGetBoundRoot(item, expectedKind, out var eventPath, out _)
                || !TryNormalizePath(candidate.MediaPath, out var candidatePath))
                return false;

            if (expectedKind == ItemLookupKind.Episode)
                return IsWithin(candidatePath, eventPath);

            var exact = string.Equals(candidatePath, eventPath, PathComparison(eventPath, candidatePath));
            return exact || (expectedKind == ItemLookupKind.Movie && IsWithin(candidatePath, eventPath));
        }

        private bool TryGetBoundRoot(
            ArrItem item,
            ItemLookupKind expectedKind,
            out string normalizedMediaPath,
            out string normalizedRoot)
        {
            normalizedMediaPath = string.Empty;
            normalizedRoot = string.Empty;
            var rootKind = expectedKind == ItemLookupKind.Episode ? ItemLookupKind.Series : expectedKind;
            if (!TryNormalizePath(item.MediaPath, out normalizedMediaPath))
                return false;
            var mediaPath = normalizedMediaPath;

            // Bind the event to the longest authoritative /rootfolder path returned by this exact
            // Arr instance. This handles filesystem roots and nested roots without guessing from
            // the item's parent path or borrowing evidence from another calendar event.
            var match = _rootBindings
                .Where(binding => binding.Instance == item.ArrInstanceKey
                    && binding.Kind == rootKind
                    && IsWithin(mediaPath, binding.Root))
                .OrderByDescending(binding => binding.Root.Length)
                .FirstOrDefault();
            if (string.IsNullOrEmpty(match.Root)
                || _ambiguousRoots.Contains((rootKind, match.Root)))
                return false;

            normalizedRoot = match.Root;
            return true;
        }

        internal static bool IsCompatible(CollectionTypeOptions? collectionType, ItemLookupKind expectedKind)
            => collectionType == CollectionTypeOptions.mixed
                || (expectedKind == ItemLookupKind.Movie && collectionType == CollectionTypeOptions.movies)
                || (expectedKind == ItemLookupKind.Series && collectionType == CollectionTypeOptions.tvshows);

        internal static (string Instance, ItemLookupKind Kind, string Path) BuildCacheKey(
            string instanceKey,
            ItemLookupKind expectedKind,
            string path)
            => (instanceKey, expectedKind, NormalizePath(path));

        internal static string NormalizePath(string path)
        {
            if (!TryNormalizePath(path, out var normalized))
                throw new ArgumentException("Path must be absolute and canonical.", nameof(path));
            return normalized;
        }

        internal static bool TryNormalizePath(string? path, out string normalized)
        {
            normalized = string.Empty;
            if (string.IsNullOrWhiteSpace(path))
                return false;

            var candidate = path.Trim().Replace('\\', '/');
            var isUnix = candidate.StartsWith('/');
            var isUnc = candidate.StartsWith("//", StringComparison.Ordinal);
            var isDrive = candidate.Length >= 3
                && char.IsAsciiLetter(candidate[0])
                && candidate[1] == ':'
                && candidate[2] == '/';
            if (!isUnix && !isDrive)
                return false;

            while (candidate.Length > (isDrive ? 3 : 1) && candidate.EndsWith('/'))
                candidate = candidate[..^1];
            if (candidate == "/" || (isDrive && candidate.Length == 3))
            {
                normalized = isDrive ? candidate.ToUpperInvariant() : candidate;
                return true;
            }

            var segmentStart = isUnc ? 2 : isUnix ? 1 : 3;
            var tail = candidate[segmentStart..];
            if (tail.Split('/', StringSplitOptions.None)
                .Any(segment => segment is "." or ".." || segment.Length == 0))
                return false;

            normalized = IsWindowsPath(candidate) ? candidate.ToUpperInvariant() : candidate;
            return true;
        }

        internal static bool IsWithin(string path, string root)
            => !string.IsNullOrEmpty(path)
                && !string.IsNullOrEmpty(root)
                && (string.Equals(path, root, PathComparison(path, root))
                || (root.EndsWith('/') && path.StartsWith(root, PathComparison(path, root)))
                || (path.Length > root.Length
                    && path.StartsWith(root, PathComparison(path, root))
                    && path[root.Length] == '/'));

        private static StringComparison PathComparison(string left, string right)
            => IsWindowsPath(left) && IsWindowsPath(right)
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;

        private static bool IsWindowsPath(string path)
            => path.StartsWith("//", StringComparison.Ordinal)
                || (path.Length >= 3 && char.IsAsciiLetter(path[0]) && path[1] == ':' && path[2] == '/');
    }
}
