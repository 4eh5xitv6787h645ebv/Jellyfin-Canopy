using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.JellyfinCanopy.Platform
{
    /// <summary>
    /// The single pagination dialect for Platform v1: opaque, forward-only cursors.
    ///
    /// <para>
    /// <c>take</c>/<c>skip</c> and <c>page</c>/<c>size</c> are deliberately not carried
    /// into the platform surface. Offset paging silently skips or repeats rows whenever
    /// the underlying collection changes between requests, and it cannot survive a change
    /// of store. Legacy routes keep their dialects; nothing is retrofitted.
    /// </para>
    /// </summary>
    public static class PlatformPaging
    {
        /// <summary>Page size used when a caller asks for none.</summary>
        public const int DefaultPageSize = 50;

        /// <summary>
        /// Largest page a caller may request.
        ///
        /// Documented rather than merely enforced: a client that asks for 10,000 gets 200
        /// and needs to know that from the contract instead of inferring it from short
        /// pages, which are otherwise indistinguishable from reaching the end.
        /// </summary>
        public const int MaximumPageSize = 200;

        /// <summary>Clamps a requested page size into the supported range.</summary>
        /// <param name="requested">What the caller asked for, if anything.</param>
        /// <returns>A size between 1 and <see cref="MaximumPageSize"/>.</returns>
        public static int NormalizePageSize(int? requested) => requested switch
        {
            null or <= 0 => DefaultPageSize,
            > MaximumPageSize => MaximumPageSize,
            _ => requested.Value,
        };

        /// <summary>
        /// Takes one page of <paramref name="ordered"/>, continuing after
        /// <paramref name="cursor"/> when one is supplied.
        ///
        /// <para>
        /// <b>The ordering requirement is the correctness requirement.</b>
        /// <paramref name="ordered"/> must be sorted ascending by <paramref name="keyOf"/>
        /// and every key must be unique, because that total order is the only thing that
        /// makes "everything after this key" a well-defined position. If it is violated a
        /// walk can skip or repeat rows — the exact failure cursors exist to prevent — so
        /// the scan verifies it as it goes and refuses rather than serving a page it
        /// cannot vouch for.
        /// </para>
        /// </summary>
        /// <typeparam name="T">The row type.</typeparam>
        /// <param name="ordered">Rows, ascending and unique by <paramref name="keyOf"/>.</param>
        /// <param name="keyOf">The total ordering key for a row.</param>
        /// <param name="scope">Identifies this listing, so a cursor cannot cross to another.</param>
        /// <param name="cursor">The caller's cursor, or <c>null</c> for the first page.</param>
        /// <param name="pageSize">Requested page size, clamped by <see cref="NormalizePageSize"/>.</param>
        /// <param name="codec">Verifies and issues cursors.</param>
        /// <param name="page">The page, when the cursor was acceptable.</param>
        /// <returns><c>false</c> when the cursor is not authentic for this scope, or the source is misordered.</returns>
        public static bool TryPaginate<T>(
            IEnumerable<T> ordered,
            Func<T, string> keyOf,
            string scope,
            string? cursor,
            int? pageSize,
            PlatformCursorCodec codec,
            out PlatformPage<T> page)
        {
            ArgumentNullException.ThrowIfNull(ordered);
            ArgumentNullException.ThrowIfNull(keyOf);
            ArgumentNullException.ThrowIfNull(codec);

            page = new PlatformPage<T>(Array.Empty<T>(), null);

            var after = string.Empty;
            if (!string.IsNullOrEmpty(cursor) && !codec.TryDecode(scope, cursor, out after))
            {
                // Never fall back to the first page. Silently restarting is
                // indistinguishable from success to the client and produces duplicates
                // without ever reporting a fault.
                return false;
            }

            var size = NormalizePageSize(pageSize);
            var items = new List<T>(Math.Min(size, 64));
            var previousKey = (string?)null;
            var more = false;

            foreach (var row in ordered)
            {
                var key = keyOf(row);

                if (previousKey is not null && string.CompareOrdinal(key, previousKey) <= 0)
                {
                    // Equal keys are as fatal as reversed ones: a duplicate key makes
                    // "after this key" ambiguous, so a walk could skip the second row or
                    // return the first one forever.
                    return false;
                }

                previousKey = key;

                if (string.CompareOrdinal(key, after) <= 0)
                {
                    continue;
                }

                if (items.Count == size)
                {
                    // One row beyond the page proves there is a next page. Issuing a
                    // cursor without that proof would hand out a token that returns
                    // nothing, so a client could not tell "more" from "done".
                    more = true;
                    break;
                }

                items.Add(row);
            }

            var nextCursor = more && items.Count > 0
                ? codec.Encode(scope, keyOf(items[^1]))
                : null;

            page = new PlatformPage<T>(items, nextCursor);
            return true;
        }
    }

    /// <summary>
    /// One page of results.
    /// </summary>
    /// <typeparam name="T">The row type.</typeparam>
    /// <param name="Items">The rows in this page, in the listing's order.</param>
    /// <param name="NextCursor">
    /// The token for the following page, or <c>null</c> when this is the last one.
    /// <c>null</c> is the only end-of-listing signal: a short page is not one, because a
    /// page can be short whenever rows are filtered after being read.
    /// </param>
    public readonly record struct PlatformPage<T>(IReadOnlyList<T> Items, string? NextCursor);
}
