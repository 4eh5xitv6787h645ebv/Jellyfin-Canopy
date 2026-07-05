// src/others/index.ts
// their required execution order (the former allComponentScripts order).
// Owned by the others conversion wave; main.ts imports this barrel once, so
// conversions never edit main.ts itself. splashscreen.js stays out-of-band
// (loaded early, before initialize()) and is deliberately NOT imported here.
import './letterboxd-links';
