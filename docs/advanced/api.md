## Jellyfin Enhanced API

### Authentication

The plugin targets **Jellyfin 12 only**, and Jellyfin 12 ignores the legacy authentication tokens (`?api_key=` query parameters, `X-Emby-Token`, `X-MediaBrowser-Token` headers). Authenticate every request with the standard header:

```
Authorization: MediaBrowser Token="{your-api-key}"
```

**Error contract:**

- Endpoints are gated with ASP.NET authorization policies (bare `[Authorize]` for any authenticated user, `RequiresElevation` for admin-only). Authorization failures return a **bare status code with an empty body** — `401` for a missing/invalid token, `403` for a valid token without the required role. There is no JSON error envelope for authorization failures; branch on the status code.
- JSON error bodies (e.g. Seerr permission codes) are used for **business errors only**, on requests that already passed authorization.

### Get Plugin Version

Checks the installed version of the Jellyfin Enhanced plugin (no authentication required):

```bash
curl -X GET \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/version"
```

### Public Configuration

The plugin serves a **public config** payload (`/JellyfinEnhanced/public-config`) that the client bootstraps from before login. Only settings whitelisted for public exposure are included — secrets (API keys, tokens) never appear.

Fields that would leak internal topology are additionally **redacted for anonymous / pre-login callers** and only returned once the request is authenticated:

- Seerr URLs.
- The **maintenance-mode target-user list** (the affected-user GUIDs) — returned empty pre-login.

The maintenance-mode **message** and **action** stay public because the login page's maintenance banner legitimately needs them before a user signs in.

## Bookmark API + Info

### Storage Directory
Bookmarks are stored per-user under the plugin's configurations directory. The user id is normalized (dashes stripped, lowercased) to form the folder name, and the file is named `bookmark.json` (singular):
```
<plugins>/configurations/Jellyfin.Plugin.JellyfinEnhanced/{userId-no-dashes-lowercase}/bookmark.json
```

The data structure is (property names are persisted as-is, in PascalCase):
```json
{
  "Bookmarks": {
    "unique-bookmark-id": {
      "ItemId": "jellyfin-item-id",
      "TmdbId": "12345",
      "TvdbId": "67890",
      "MediaType": "movie" | "tv",
      "Name": "Item Name",
      "Timestamp": 123.45,
      "Label": "Epic scene",
      "CreatedAt": "2026-01-03T12:00:00.000Z",
      "UpdatedAt": "2026-01-03T12:00:00.000Z",
      "SyncedFrom": "original-item-id"
    }
  }
}
```

### API Access

External applications can read and write bookmarks using the Jellyfin Enhanced API endpoints

`{userId}` is the 32-character hex (`"N"` format) Jellyfin user id.

#### Get Bookmarks
```http
GET /JellyfinEnhanced/user-settings/{userId}/bookmark.json
Authorization: MediaBrowser Token="{your-api-key}"
```

#### Save Bookmarks

The request body is the `UserBookmark` object itself — a single `Bookmarks` map — not an envelope. This performs a full replace of the user's bookmarks.

```http
POST /JellyfinEnhanced/user-settings/{userId}/bookmark.json
Authorization: MediaBrowser Token="{your-api-key}"
Content-Type: application/json

{
  "Bookmarks": { ... }
}
```

## Seerr Integration API

Plugin exposes proxy endpoints for Seerr:

!!! note "About the `X-Jellyfin-User-Id` header"
    The `X-Jellyfin-User-Id` header shown in the examples below is a client-side convention only — the server never reads it. The acting user is resolved solely from the auth token's `Jellyfin-UserId` claim, so each endpoint always acts as the token's own user. You cannot use this header to act as another user id, and it can be omitted entirely.

### Check Connection Status

Checks if the plugin can connect to any of the configured Seerr URLs using the provided API key.

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/status"
```

### Check User Status

Verifies that the currently logged-in Jellyfin user is successfully linked to a Seerr user account.

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<JELLYFIN_API_KEY>\"" \
  -H "X-Jellyfin-User-Id: <JELLYFIN_USER_ID>" \
  "<JELLYFIN_ADDRESS>/JellyfinEnhanced/jellyseerr/user-status"
```

### Perform A Seerr Search

Executes a search query through the Seerr instance for the specified user.

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/search?query=Inception"
```

### Make a Request on Seerr

Submits a media request to Seerr on behalf of the specified user.

- `mediaType` can be `tv` or `movie`\
- `mediaId` is the **TMDB ID** of the item

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"<API_KEY>\"" \
  -H "X-Jellyfin-User-Id: <USER_ID>" \
  -H "Content-Type: application/json" \
  -d '{"mediaType": "movie", "mediaId": 27205}' \
  "<JELLYFIN_URL>/JellyfinEnhanced/jellyseerr/request"
```

## Admin Hidden Content API

Admin-only endpoints that let an administrator view and manage what **other** users have hidden. Every endpoint requires a Jellyfin **administrator** token (enforced server-side via the `RequiresElevation` policy) and the **Let admins view and manage other users' hidden content** toggle (**Pages → Hidden Content → Admin Controls**) to be enabled; otherwise it returns a bare `403` (empty body). `<USER_ID>` is the 32-character hex (`"N"` format) Jellyfin user id.

### List Users With Hidden Content

Returns each user (except the caller) who has hidden at least one item, with their hidden-item count, used to populate the admin user-filter dropdown.

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content-users"
```

### Get A User's Hidden Content

Returns a single user's hidden content (read-only).

```bash
curl -X GET \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content/<USER_ID>"
```

### Unhide Items For A User

Removes one or more items from a user's hidden list. The body is a JSON array of item keys (an `itemId`, or `tmdb-<id>` for items not in the library).

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  -H "Content-Type: application/json" \
  -d '["a1b2c3d4e5f6...", "tmdb-27205"]' \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content/<USER_ID>/unhide"
```

### Hide Items For A User

Adds one or more items to a user's hidden list (max 200 per call; an item the user hid themselves is never overwritten). The body is a JSON array of hidden-content items.

```bash
curl -X POST \
  -H "Authorization: MediaBrowser Token=\"<ADMIN_API_KEY>\"" \
  -H "Content-Type: application/json" \
  -d '[{"TmdbId": "27205", "Name": "Inception", "Type": "Movie", "PosterPath": "/edv5CZvWj09upOsy2Y6IwDhK8bt.jpg"}]' \
  "<JELLYFIN_URL>/JellyfinEnhanced/admin/hidden-content/<USER_ID>/hide"
```