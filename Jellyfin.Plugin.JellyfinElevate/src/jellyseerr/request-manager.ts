// src/jellyseerr/request-manager.ts
//
// The retry/dedup/concurrency/cache machinery moved to src/core/api-client.ts
// so every module (not just Seerr) can use it. This file keeps the frozen
// JE.requestManager surface as an alias; the navigation-abort wiring that
// used to live here is owned by core/api-client.ts (via JE.core.navigation,
// which also covers the pushState transitions the old raw hashchange/popstate
// listeners missed).

import { JE } from '../globals';

// core/api-client.ts (imported by main.ts before this module) always sets
// JE.core.api — a missing surface means broken bundle ordering.
JE.requestManager = JE.core.api!.manager;
