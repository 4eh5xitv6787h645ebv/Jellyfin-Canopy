# Live Updates

Jellyfin Enhanced keeps open browser sessions in step with the server without manual refreshes. The client subscribes once to Jellyfin 12's websocket (the SDK socket — see [Jellyfin 12 Platform](../v12-platform.md#2-script-injection-events-s2)) and fans the server's pushes out to the plugin's features.

## What updates without a refresh

| Change on the server | What happens in open sessions |
|---|---|
| **Admin saves plugin configuration** | Every open session refetches the plugin config and applies it live — toggles that drive cheap, idempotent surfaces (e.g. tag overlays) re-render in place; everything else picks up the fresh values on its next page mount. No reload needed. |
| **Watch state changes** (played/favorite/progress — from any device) | Watch-state-dependent overlays (rating/user-review tags) are rescanned so they match the new state. |
| **Library changes** (items added/updated/removed) | Newly mounted cards are tagged as usual; a coalesced rescan picks up data changes behind already-visible cards. The *arr requests/downloads page refreshes its list when a monitored download lands in the library. |
| **The plugin itself is updated** (new DLL while sessions are open) | Sessions still running the old client bundle detect the newer server version and show a **one-time toast** prompting a refresh. The toast only fires when the server version is strictly newer than the one the session loaded — never for a same-version session. |

## Honest limits

- **One reload after a plugin update.** A running page cannot hot-swap its own code; after updating the plugin, each open session needs one refresh (that is exactly what the update toast asks for). Everything after that reload is current.
- **Not every feature re-initializes from a config change alone.** The config values update live everywhere, but a few heavy per-page injectors only rebuild their DOM on the next navigation or page mount.
- **Native surfaces refresh on their own schedule.** Jellyfin's own UI (home rows, item details) updates via its own mechanisms; the plugin only guarantees liveness for the surfaces it draws. Where the native layout provides no refresh path, the plugin does not force one — deliberately, to avoid flicker and layout shift.
- **Fails soft.** If the live socket is unavailable, features fall back to polling and manual refresh — nothing breaks, updates are just not instant.

## For developers

Client features subscribe through the live hub instead of polling:

```ts
import { LIVE, on } from '../core/live';

on(LIVE.CONFIG_CHANGED, () => { /* re-read JE.pluginConfig, re-render */ });
on(LIVE.LIBRARY_CHANGED, (data) => { /* items added/updated/removed */ });
on(LIVE.USER_DATA_CHANGED, (data) => { /* watch-state changes */ });
```

The server side pushes through `ISessionManager` (`Services/LiveNotifierService.cs`), reusing message types the Jellyfin 12 client already consumes (`UserDataChanged`, `LibraryChanged`) plus a marked `GeneralCommand` as the plugin's own channel. That carrier command is deliberately one the native web client's `GeneralCommand` handler **ignores**, so a config-changed push never triggers real UI on non-plugin clients — a `LiveNotifierServiceTests` denylist asserts the carrier is never a command web clients act on. The websocket behavior, auth caveats and message shapes are documented in [Jellyfin 12 Platform](../v12-platform.md#4-server-api-surface-s3).

**The push is scoped to sessions that actually run JE.** The carrier is a playback-shaped `GeneralCommand`, and while jellyfin-web provably ignores it, how a *native* client (Android, Android TV, Kodi, third-party apps) handles an unsolicited playback command is outside the plugin's control — the original broadcast to every session of every user delivered it to all of them on every config save. `Services/LiveSessionRegistry.cs` fixes the targeting: every JE client boot and every hot-reload refetch calls `/JellyfinEnhanced/public-config` authenticated, and the 15-minute self-update recheck calls `/JellyfinEnhanced/version` — both record the calling session's device id (the `Jellyfin-DeviceId` claim) into a bounded, TTL'd registry, and `LiveNotifierService` sends the config-changed command per registered device via `SendMessageToUserDeviceSessions`. Native clients never call JE endpoints, so they can never be registered and never receive the carrier. The registry is self-healing: a server restart empties it, open web sessions re-register within one 15-minute recheck, and a session that misses a push simply picks the new config up on its next load (fail-soft).
