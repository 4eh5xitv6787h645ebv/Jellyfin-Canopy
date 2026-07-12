/**
 * One-time localStorage migration from the plugin's former "Jellyfin Elevate"
 * identity (pre-2.0). The only device-local state worth carrying over is the
 * admin-clear marker: without it, an already-processed "clear local storage"
 * request would re-fire on every device right after the upgrade. The legacy
 * settings blob itself is dead weight (settings live server-side) and is
 * removed outright.
 *
 * Idempotent: once the legacy keys are gone this is a no-op.
 */
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
    } catch {
        // Storage can be blocked (private mode, embedded webviews); the clear
        // flow already tolerates a missing marker, so silently skip.
    }
}
