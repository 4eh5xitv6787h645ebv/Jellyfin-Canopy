// src/core/identity.ts
//
// Bundle-side participant for the loader-owned identity controller. The
// controller itself must live in js/plugin.js so it can intercept Jellyfin's
// authentication setter before this bundle exists; this module connects that
// early owner to the reusable core teardown infrastructure.

import { JC } from '../globals';
import { teardownAll } from './lifecycle';

JC.identity.registerReset('core-platform', () => {
    // Abort transport first, then remove feature resources. A promise that has
    // already resolved is still fenced by its captured epoch in api-client.ts.
    try { JC.core.api?.manager.abortAllRequests(); } catch { /* continue teardown */ }
    try { JC.core.api?.manager.clearCache(); } catch { /* continue teardown */ }
    try { teardownAll(); } catch (error) {
        console.error('🪼 Jellyfin Canopy: identity core teardown failed', error);
    }

    // Modules may stamp ephemeral nodes that are not attached to a feature
    // lifecycle yet. This is intentionally narrow: global shared observers and
    // process-lifetime styles remain intact and are re-used by B.
    document.querySelectorAll('[data-jc-identity-owned="true"]').forEach((node) => node.remove());
});
