// src/arr/index.ts
// their required execution order (mirrors the former js/plugin.js
// allComponentScripts arr section). Owned by the arr conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
import './arr-links';
import './arr-tag-links';
// The requests/downloads and calendar SCCs are route-only ESM entries. They
// must not enter the cold-home graph through this eager area barrel.
// Admin-only action-sheet Search / Interactive Search / Manage (Sonarr/Radarr).
import './search';
