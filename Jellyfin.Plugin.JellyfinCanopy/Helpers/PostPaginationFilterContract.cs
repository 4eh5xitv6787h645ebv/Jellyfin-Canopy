using System;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JellyfinCanopy.Helpers
{
    /// <summary>
    /// Truthful contract for policy filters that run after an upstream owner has
    /// already selected a page. The filtered page can be made private, but an
    /// exact filtered total cannot be derived from that one slice. Preserve the
    /// upstream total as a navigation upper bound and mark it explicitly instead
    /// of subtracting this page's removals from a global count.
    /// </summary>
    internal static class PostPaginationFilterContract
    {
        internal const string ContractName = "upstream-total-upper-bound";
        internal const string HeaderName = "X-Jellyfin-Canopy-Filtered-Pagination";
        internal const string ExactHeaderName = "X-Jellyfin-Canopy-Filtered-Total-Exact";
        internal const string RemovedHeaderName = "X-Jellyfin-Canopy-Filtered-Page-Removed";
        internal const string JsonPropertyName = "jellyfinCanopyPagination";

        internal static int NavigationTotal(int upstreamTotal, int removedFromPage)
        {
            // Treat malformed negative upstream metadata as zero without
            // throwing from a privacy filter. The removal count is deliberately
            // irrelevant to the global total because it describes one page only.
            _ = removedFromPage;
            return Math.Max(0, upstreamTotal);
        }

        internal static void MarkResponse(HttpResponse response, int removedFromPage)
        {
            ArgumentNullException.ThrowIfNull(response);
            response.Headers[HeaderName] = ContractName;
            response.Headers[ExactHeaderName] = "false";
            response.Headers[RemovedHeaderName] = Math.Max(0, removedFromPage)
                .ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        internal static void MarkJson(JsonObject root, int removedFromPage)
        {
            ArgumentNullException.ThrowIfNull(root);
            if (!HasPaginationShape(root))
            {
                return;
            }

            root[JsonPropertyName] = new JsonObject
            {
                ["contract"] = ContractName,
                ["totalExact"] = false,
                ["removedFromPage"] = Math.Max(0, removedFromPage),
            };
        }

        private static bool HasPaginationShape(JsonObject root)
            => root["pageInfo"] is JsonObject
                || root["totalResults"] is not null
                || root["totalPages"] is not null;
    }
}
