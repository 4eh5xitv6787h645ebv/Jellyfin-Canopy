// src/extras/index.ts — area barrel: imports this area's converted modules in
// their required execution order (the former allComponentScripts order).
// Owned by the extras conversion wave; main.ts imports this barrel once, so
// conversions never edit main.ts itself. login-image.js stays out-of-band
// (loaded pre-login, config-gated) and is deliberately NOT imported here.
import './colored-activity-icons';
import './colored-ratings';
import './plugin-icons';
import './theme-selector';
import './active-streams';
