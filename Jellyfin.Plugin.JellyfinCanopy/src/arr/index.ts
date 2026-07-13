// src/arr/index.ts
// their required execution order (mirrors the former js/plugin.js
// allComponentScripts arr section). Owned by the arr conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
import './arr-links';
import './arr-tag-links';
import './requests/styles';
import './requests/data';
import './requests/render-helpers';
import './requests/render-cards';
import './requests/render';
import './requests/actions';
import './requests/init';
import './calendar/styles';
import './calendar/data';
import './calendar/render-events';
import './calendar/render-views';
import './calendar/actions';
import './calendar/page';
import './requests/custom-tab';
// Admin-only action-sheet Search / Interactive Search / Manage (Sonarr/Radarr).
import './search';
