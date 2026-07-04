// src/arr/index.ts — area barrel: imports this area's converted modules in
// their required execution order (mirrors the former js/plugin.js
// allComponentScripts arr section). Owned by the arr conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
import './arr-links';
import './arr-tag-links';
import './requests-page-styles';
import './requests-page-data';
import './requests-page-render-helpers';
import './requests-page-render-cards';
import './requests-page-render';
import './requests-page-actions';
import './requests-page-init';
import './calendar-page-styles';
import './calendar-page-data';
import './calendar-page-render-events';
import './calendar-page-render-views';
import './calendar-page-actions';
import './calendar-page-init';
import './requests-custom-tab';
import './calendar-custom-tab';
