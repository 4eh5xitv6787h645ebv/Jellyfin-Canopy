// src/seerr/request-manager.ts
//
// The retry/dedup/concurrency/cache machinery moved to src/core/api-client.ts
// so every module (not just Seerr) can use it. This file keeps the frozen
// JC.requestManager surface as an alias; the navigation-abort wiring that
// used to live here is owned by core/api-client.ts (via JC.core.navigation,
// which also covers the pushState transitions the old raw hashchange/popstate
// listeners missed).

import { JC } from '../globals';

// core/api-client.ts (imported by main.ts before this module) always sets
// JC.core.api — a missing surface means broken bundle ordering.
JC.requestManager = JC.core.api!.manager;
