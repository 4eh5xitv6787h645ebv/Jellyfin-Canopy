// src/jellyseerr/index.ts — area barrel: imports this area's converted modules in
// their required execution order. Owned by the jellyseerr conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
// Relative order mirrors the former js/plugin.js allComponentScripts jellyseerr
// block; unconverted files still ride in via the legacy array appended by
// scripts/build-bundle.js.
import './seerr-status';
import './request-manager';
import './api';
import './jellyseerr';
import './modal';
import './item-details';
import './issue-reporter';
