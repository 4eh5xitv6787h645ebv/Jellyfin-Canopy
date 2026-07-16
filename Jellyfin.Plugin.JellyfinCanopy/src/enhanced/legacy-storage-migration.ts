/**
 * One-time localStorage migration from the plugin's former "Jellyfin Elevate"
 * identity (pre-2.0). Durable per-user preferences are adopted under their
 * Canopy names (never overwriting state a Canopy build already wrote); the
 * legacy self-rebuilding caches are dropped outright so they stop leaking
 * storage under a dead identity.
 *
 * Idempotent: once the legacy keys are gone this is a no-op.
*/

import { JC } from '../globals';

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
    const storage = JC.storage.local;
    const adopt = (currentKey: string, legacyKey: string, keyLabel: string): void => {
        const current = storage.read('legacy-storage-migration', currentKey, keyLabel);
        if (current.state !== 'Missing' && current.state !== 'Valid') return;
        if (current.state === 'Missing') {
            const legacy = storage.read('legacy-storage-migration', legacyKey, `legacy-${keyLabel}`);
            if (legacy.state !== 'Valid') return;
            if (storage.write('legacy-storage-migration', currentKey, legacy.value, keyLabel).state !== 'Valid') return;
        }
        storage.remove('legacy-storage-migration', legacyKey, `legacy-${keyLabel}`);
    };

    adopt('jellyfinCanopyLastCleared', 'jellyfinElevateLastCleared', 'clear-timestamp');
    storage.remove('legacy-storage-migration', 'jellyfinElevateSettings', 'legacy-settings');

        // Hide-confirm "don't ask again" suppression window (15 min): adopt an
        // active legacy timestamp so the user's explicit choice survives the
        // upgrade, and drop the stale key either way.
    adopt('jc_hide_confirm_suppressed_until', 'je_hide_confirm_suppressed_until', 'hide-suppression');

        // Prefix-keyed state: snapshot the key list first — removing while
        // indexing through localStorage.length re-orders the remaining keys.
    const keys = storage.keys('legacy-storage-migration', 'legacy-prefix-scan');
    for (const key of keys.value || []) {
        const adoption = ADOPT_PREFIXES.find(([legacy]) => key.startsWith(legacy));
        if (adoption) {
            const newKey = adoption[1] + key.slice(adoption[0].length);
            const current = storage.read('legacy-storage-migration', newKey, 'prefixed-preference');
            if (current.state !== 'Missing' && current.state !== 'Valid') continue;
            if (current.state === 'Missing') {
                const legacy = storage.read('legacy-storage-migration', key, 'legacy-prefixed-preference');
                if (legacy.state !== 'Valid') continue;
                if (storage.write('legacy-storage-migration', newKey, legacy.value, 'prefixed-preference').state !== 'Valid') continue;
            }
            storage.remove('legacy-storage-migration', key, 'legacy-prefixed-preference');
            continue;
        }
        if (DROP_PREFIXES.some((prefix) => key.startsWith(prefix))) {
            storage.remove('legacy-storage-migration', key, 'legacy-cache-entry');
        }
    }
}
