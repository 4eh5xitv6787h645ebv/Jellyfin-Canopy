// src/seerr/request-manager.ts
//
// The retry/dedup/concurrency/cache machinery moved to src/core/api-client.ts
// so every module (not just Seerr) can use it. This file keeps the frozen
// JC.requestManager surface as an alias; the navigation-abort wiring that
// used to live here is owned by core/api-client.ts (via JC.core.navigation,
// which also covers the pushState transitions the old raw hashchange/popstate
// listeners missed).

import { JC } from '../globals';

/** Publish the core manager alias only when the Seerr foundation activates. */
export function installSeerrRequestManager(): () => void {
    // core/api-client.ts is boot-owned and must exist before features activate.
    JC.requestManager = JC.core.api!.manager;
    return () => undefined;
}
