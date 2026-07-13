// src/enhanced/pages/index.ts
//
// Pages framework bootstrap. Imported from main.ts BEFORE the feature
// barrels so page descriptors registered by feature modules land in an
// initialized registry, and so the early mask exists as close to bundle
// parse as possible (404-flash window on cold deep links).
//
// Ordering within this module: installEarlyMask runs at import time
// (parse-time — it is the whole point); the host + entry points are wired
// once by initPagesFramework, called from js/plugin.js Stage 6 after config
// and translations are available (entry-point labels + availability gates
// read live config anyway, so late registration is safe).

import { JC } from '../../globals';
import { installEarlyMask } from './early-mask';
import { initFallbackHost, lateAdoptIfOnPage } from './fallback-host';
import { initEntryPoints } from './entry-points';

installEarlyMask();

let initialized = false;

/** Wire the permanent host hooks + entry points (idempotent). */
export function initPagesFramework(): void {
    if (initialized) {
        // A repeated Stage-6 boot (enforcement reload paths re-run init)
        // only needs the cold-start adoption check.
        lateAdoptIfOnPage();
        return;
    }
    initialized = true;
    initFallbackHost();
    initEntryPoints();
}

JC.initializePagesFramework = initPagesFramework;
