// /js/arr/requests-page-data.js
// Requests Page — state, avatar handling and data access (split from
// requests-page.js). The former raw JSON fetch() calls with hand-built auth
// headers are routed through JE.core.api.plugin; the avatar fetch stays raw
// because it returns a binary blob (JE.core.api is JSON-only).
(function () {
  "use strict";

  const JE = window.JellyfinEnhanced;
  JE.internals = JE.internals || {};
  const P = (JE.internals.requestsPage = JE.internals.requestsPage || {});

  // requests-page-render.js loads after this module — resolve renderPage at call time.
  const renderPage = () => P.renderPage();

  const logPrefix = '🪼 Jellyfin Enhanced: Requests Page:';

  // State management
  const state = {
    downloads: [],
    requests: [],
    requestsPage: 1,
    requestsTotalPages: 1,
    requestsFilter: "all",
    canApproveRequests: false,
    issues: [],
    issuesPage: 1,
    issuesTotalPages: 1,
    issuesError: false,
    issuesFilter: "open",
    isLoading: false,
    pollTimer: null,
    pageVisible: false,
    previousPage: null,
    locationSignature: null,
    locationUnsubscribe: null,
    downloadsActiveTab: "all",
    downloadsSearchQuery: "",
    downloadsSearchVisible: false,
    searchDebounceTimer: null,
    _customTabContainer: null,
  };

  const issueMediaCache = new Map();
  const avatarObjectUrlCache = new Map();
  const avatarFetchPromises = new Map();

  /**
   * Get API authentication headers.
   * Only used by the avatar blob fetch below — every JSON call goes through
   * JE.core.api.plugin, which builds its own auth headers.
   */
  function getAuthHeaders() {
    const token = ApiClient.accessToken ? ApiClient.accessToken() : "";
    return {
      "Authorization": 'MediaBrowser Token="' + token + '"',
      "X-MediaBrowser-Token": token,
      "Content-Type": "application/json",
    };
  }

  /**
   * Revoke all cached avatar blob URLs and clear the result cache.
   * @param {boolean} [includeInFlight] - If true, also cancel pending fetch promises.
   *   Pass true on page teardown; omit on re-render to let in-flight fetches complete.
   */
  function clearAvatarObjectUrlCache(includeInFlight) {
    avatarObjectUrlCache.forEach((objectUrl) => URL.revokeObjectURL(objectUrl));
    avatarObjectUrlCache.clear();
    // Only clear in-flight promises on page teardown, not on re-render.
    // Clearing mid-flight would cause duplicate downloads for the same avatar.
    if (includeInFlight) {
      avatarFetchPromises.clear();
    }
  }

  function isSafeAvatarUrl(url) {
    if (!url || typeof url !== "string") return false;

    // Relative paths are resolved by the browser against current origin and are allowed.
    if (url.startsWith("/")) return true;

    if (url.startsWith("blob:")) return true;

    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return true;
      }

      // Only allow image data URLs.
      if (parsed.protocol === "data:") {
        return /^data:image\//i.test(url);
      }
    } catch {
      return false;
    }

    return false;
  }

  /**
   * Resolve a protected avatar URL to a blob object URL.
   * Deduplicates concurrent fetches so that multiple cards referencing the
   * same avatar share a single network request instead of each downloading
   * the full image independently.
   * @param {string} avatarUrl - The avatar proxy URL to resolve
   * @returns {Promise<string>} A blob: object URL, or "" on failure
   */
  async function resolveProtectedAvatarUrl(avatarUrl) {
    if (!avatarUrl) return "";

    if (!isSafeAvatarUrl(avatarUrl)) {
      return "";
    }

    if (!avatarUrl.startsWith("/JellyfinEnhanced/proxy/avatar")) return avatarUrl;

    if (avatarObjectUrlCache.has(avatarUrl)) {
      return avatarObjectUrlCache.get(avatarUrl);
    }

    // Deduplicate in-flight fetches: if a fetch for this URL is already
    // in progress, await the same promise instead of starting a new one.
    // This prevents N parallel downloads of the same large avatar image
    // when N request cards reference the same user.
    if (avatarFetchPromises.has(avatarUrl)) {
      return avatarFetchPromises.get(avatarUrl);
    }

    const fetchPromise = (async () => {
      try {
        const response = await fetch(ApiClient.getUrl(avatarUrl), { headers: getAuthHeaders() });
        if (!response.ok) return "";
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        avatarObjectUrlCache.set(avatarUrl, objectUrl);
        return objectUrl;
      } catch {
        return "";
      } finally {
        avatarFetchPromises.delete(avatarUrl);
      }
    })();

    avatarFetchPromises.set(avatarUrl, fetchPromise);
    return fetchPromise;
  }

  function hydrateAvatarImages(container) {
    const avatarImgs = container.querySelectorAll("img.je-request-avatar[data-avatar-src]");
    avatarImgs.forEach(async (img) => {
      const sourceUrl = img.getAttribute("data-avatar-src");
      if (!sourceUrl) {
        img.style.display = "none";
        return;
      }

      const resolvedUrl = await resolveProtectedAvatarUrl(sourceUrl);
      if (!img.isConnected) return;

      if (!resolvedUrl) {
        img.style.display = "none";
        return;
      }

      if (!isSafeAvatarUrl(resolvedUrl)) {
        img.style.display = "none";
        return;
      }

      img.src = resolvedUrl;
      img.style.display = "";
    });
  }

  /**
   * Fetch download queue from backend
   */
  async function fetchDownloads() {
    try {
      const data = await JE.core.api.plugin("/arr/queue");
      state.downloads = data.items || [];
      // Surface per-instance queue errors so a 401 / timeout / SSRF-reject on one
      // instance doesn't silently produce a "looks empty" downloads page.
      surfaceDownloadsErrors(data.errors);
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch downloads:`, error);
      state.downloads = [];
      return null;
    }
  }

  // Once-per-session dedup. Self-heals: when an error stops appearing in a subsequent fetch
  // the memo entry is dropped so future occurrences re-toast.
  const _toastedDownloadsErrors = new Set();
  // Alias the shared HTML-escape helper (JE.toast uses innerHTML).
  // The inline fallback is a real escaper so XSS is blocked even if helpers.js
  // hasn't loaded yet (e.g. a load-order race on first init).
  const esc = (s) => {
    if (window.JellyfinEnhanced?.helpers?.escHtml) return window.JellyfinEnhanced.helpers.escHtml(s);
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  };
  function surfaceDownloadsErrors(errors) {
    if (!Array.isArray(errors) || errors.length === 0) {
      _toastedDownloadsErrors.clear();
      return;
    }
    const seenThisTick = new Set();
    errors.forEach(function(err) {
      const key = (err.source || "") + "|" + (err.instanceName || "") + "|" + (err.reason || "");
      seenThisTick.add(key);
      if (_toastedDownloadsErrors.has(key)) return;
      _toastedDownloadsErrors.add(key);
      if (typeof window.JellyfinEnhanced?.toast === "function") {
        window.JellyfinEnhanced.toast(
          "⚠ " + esc(err.source || "Arr") + " queue \"" +
          esc(err.instanceName || "unknown") + "\" failed: " + esc(err.reason)
        );
      }
      console.warn(`${logPrefix} ${err.source || "Arr"} queue "${err.instanceName}" error: ${err.reason}`);
    });
    Array.from(_toastedDownloadsErrors).forEach(function(k) {
      if (!seenThisTick.has(k)) _toastedDownloadsErrors.delete(k);
    });
  }

  /**
   * Fetch requests from backend
   */
  async function fetchRequests() {
    try {
      const skip = (state.requestsPage - 1) * 20;
      const filter = state.requestsFilter !== "all" ? state.requestsFilter : "";

      const query = new URLSearchParams({
        take: "20",
        skip: String(skip),
        filter: filter,
      });

      const data = await JE.core.api.plugin(`/arr/requests?${query.toString()}`);

      state.requests = data.requests || [];
      state.requestsTotalPages = data.totalPages || 1;
      state.canApproveRequests = data.canApproveRequests === true;

      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch requests:`, error);
      state.requests = [];
      return null;
    }
  }

  function getIssueMediaType(issue) {
    const media = issue?.media || {};
    return (media.mediaType || issue?.mediaType || issue?.type || "").toLowerCase();
  }

  function getIssueTmdbId(issue) {
    const media = issue?.media || {};
    return media.tmdbId || issue?.tmdbId || null;
  }

  function applyIssueMediaDetails(issue, details, mediaType) {
    if (!details || !issue) return issue;
    const title = details.title || details.name || details.originalTitle || details.originalName;
    const posterPath = details.posterPath || details.poster_path || null;
    const releaseDate = details.releaseDate || details.release_date || null;
    const firstAirDate = details.firstAirDate || details.first_air_date || null;
    const tmdbId = details.id || details.tmdbId || getIssueTmdbId(issue);
    const mediaInfo = details.mediaInfo || details.mediaInfo4k || details.mediaInfo4K || null;

    issue.media = {
      ...(issue.media || {}),
      title: title || issue.media?.title,
      name: details.name || issue.media?.name,
      originalTitle: details.originalTitle || issue.media?.originalTitle,
      originalName: details.originalName || issue.media?.originalName,
      posterPath: posterPath || issue.media?.posterPath,
      releaseDate: releaseDate || issue.media?.releaseDate,
      firstAirDate: firstAirDate || issue.media?.firstAirDate,
      tmdbId: tmdbId || issue.media?.tmdbId,
      mediaType: mediaType || issue.media?.mediaType,
      mediaInfo: mediaInfo || issue.media?.mediaInfo,
    };

    return issue;
  }

  async function fetchIssueMediaDetails(mediaType, tmdbId) {
    if (!mediaType || !tmdbId) return null;
    const cacheKey = `${mediaType}:${tmdbId}`;
    if (issueMediaCache.has(cacheKey)) return issueMediaCache.get(cacheKey);

    const path = mediaType === "tv"
      ? `/JellyfinEnhanced/jellyseerr/tv/${tmdbId}`
      : `/JellyfinEnhanced/jellyseerr/movie/${tmdbId}`;

    try {
      const data = await ApiClient.ajax({
        type: "GET",
        url: ApiClient.getUrl(path),
        dataType: "json",
        headers: { "X-Jellyfin-User-Id": ApiClient.getCurrentUserId() },
      });
      issueMediaCache.set(cacheKey, data || null);
      return data || null;
    } catch (error) {
      issueMediaCache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Fetch issues from Jellyseerr
   */
  async function fetchIssues() {
    if (!JE.pluginConfig?.JellyseerrEnabled || !JE.pluginConfig?.DownloadsPageShowIssues) {
      state.issues = [];
      state.issuesTotalPages = 1;
      state.issuesError = false;
      return null;
    }
    // Stop trying if we already know the user lacks VIEW_ISSUES permission
    if (state.issuesPermissionDenied) return null;

    try {
      const skip = (state.issuesPage - 1) * 20;
      const filter = state.issuesFilter || "open";
      const url = ApiClient.getUrl("/JellyfinEnhanced/jellyseerr/issue", {
        take: 20,
        skip: skip,
        filter: filter,
        sort: "added",
      });

      const data = await ApiClient.ajax({
        type: "GET",
        url: url,
        dataType: "json",
        headers: { "X-Jellyfin-User-Id": ApiClient.getCurrentUserId() },
      });

      let issues = data?.results || [];
      if (issues.length) {
        issues = await Promise.all(
          issues.map(async (issue) => {
            const mediaType = getIssueMediaType(issue);
            const tmdbId = getIssueTmdbId(issue);
            const details = await fetchIssueMediaDetails(mediaType, tmdbId);
            return applyIssueMediaDetails(issue, details, mediaType);
          })
        );
      }

      state.issues = issues;
      state.issuesTotalPages = data?.pageInfo?.pages || data?.totalPages || 1;
      state.issuesError = false;
      return data;
    } catch (error) {
      console.error(`${logPrefix} Failed to fetch issues:`, error);
      state.issues = [];
      state.issuesTotalPages = 1;
      state.issuesError = true;
      // 403 = no VIEW_ISSUES permission — surface once as a toast, then stop polling issues
      if (error?.status === 403) {
        state.issuesPermissionDenied = true;
        if (typeof JE?.toast === 'function') {
          JE.toast(JE.t?.('jellyseerr_err_no_issue_view_permission') || 'No permission to view issues', 4000);
        }
      }
      return null;
    }
  }

  /**
   * Load all data
   */
  async function loadAllData() {
    state.isLoading = true;
    renderPage();

    await Promise.all([fetchDownloads(), fetchRequests(), fetchIssues()]);

    state.isLoading = false;
    renderPage();
  }

  async function handleRequestAction(btn, action) {
    const requestId = btn.getAttribute('data-request-id');
    if (!requestId) return;

    btn.disabled = true;
    const icon = btn.querySelector('.material-icons');
    if (icon) icon.textContent = 'hourglass_empty';

    try {
      // skipRetry: approving/declining is not idempotent — never auto-repeat it.
      await JE.core.api.plugin(`/arr/requests/${requestId}/${action}`, {
        method: 'POST',
        skipRetry: true,
      });
      await fetchRequests();
      renderPage();
    } catch (err) {
      console.error(`${logPrefix} Failed to ${action} request ${requestId}:`, err);
      btn.disabled = false;
      if (icon) icon.textContent = action === 'approve' ? 'check' : 'close';
    }
  }

  P.state = state;
  P.clearAvatarObjectUrlCache = clearAvatarObjectUrlCache;
  P.hydrateAvatarImages = hydrateAvatarImages;
  P.fetchRequests = fetchRequests;
  P.fetchIssues = fetchIssues;
  P.getIssueMediaType = getIssueMediaType;
  P.getIssueTmdbId = getIssueTmdbId;
  P.loadAllData = loadAllData;
  P.handleRequestAction = handleRequestAction;
})();
