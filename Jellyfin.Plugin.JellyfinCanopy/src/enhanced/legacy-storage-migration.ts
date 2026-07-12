/**
 * One-time localStorage migration from the plugin's former "Jellyfin Elevate"
 * identity (pre-2.0). Durable per-user preferences are adopted under their
 * Canopy names (never overwriting state a Canopy build already wrote); the
 * legacy self-rebuilding caches are dropped outright so they stop leaking
 * storage under a dead identity.
 *
 * Idempotent: once the legacy keys are gone this is a no-op.
 */

/** Durable pref prefixes: adopt value under the new prefix, then drop the old key. */
const ADOPT_PREFIXES: ReadonlyArray<readonly [legacy: string, current: string]> = [
    // Per-user Discovery row customization (see discovery/prefs.ts) — an
    // explicit empty array is a real choice and must survive the upgrade.
    ['je-discovery-rows:', 'jc-discovery-rows:'],
];

/** Legacy cache prefixes: safe to discard, the features rebuild them on demand. */
const DROP_PREFIXES: readonly string[] = [
    'JellyfinElevate-',   // tag family caches (people/quality/genre/language/rating)
    'JE_translation_',    // versioned translation cache
    'je_conn_test_',      // admin config-page connection-test cache (TTL'd)
];

export function migrateLegacyClientStorage(): void {
    try {
        if (localStorage.getItem('jellyfinCanopyLastCleared') === null) {
            const legacyCleared = localStorage.getItem('jellyfinElevateLastCleared');
            if (legacyCleared !== null) {
                localStorage.setItem('jellyfinCanopyLastCleared', legacyCleared);
            }
        }
        localStorage.removeItem('jellyfinElevateLastCleared');
        localStorage.removeItem('jellyfinElevateSettings');

        // Hide-confirm "don't ask again" suppression window (15 min): adopt an
        // active legacy timestamp so the user's explicit choice survives the
        // upgrade, and drop the stale key either way.
        if (localStorage.getItem('jc_hide_confirm_suppressed_until') === null) {
            const legacySuppressed = localStorage.getItem('je_hide_confirm_suppressed_until');
            if (legacySuppressed !== null) {
                localStorage.setItem('jc_hide_confirm_suppressed_until', legacySuppressed);
            }
        }
        localStorage.removeItem('je_hide_confirm_suppressed_until');

        // Prefix-keyed state: snapshot the key list first — removing while
        // indexing through localStorage.length re-orders the remaining keys.
        const keys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key !== null) keys.push(key);
        }
        for (const key of keys) {
            const adoption = ADOPT_PREFIXES.find(([legacy]) => key.startsWith(legacy));
            if (adoption) {
                const newKey = adoption[1] + key.slice(adoption[0].length);
                if (localStorage.getItem(newKey) === null) {
                    const value = localStorage.getItem(key);
                    if (value !== null) localStorage.setItem(newKey, value);
                }
                localStorage.removeItem(key);
                continue;
            }
            if (DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
                localStorage.removeItem(key);
            }
        }
    } catch {
        // Storage can be blocked (private mode, embedded webviews); every
        // consumer already tolerates missing keys, so silently skip.
    }
}
