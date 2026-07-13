// src/seerr/index.ts
// their required execution order. Owned by the seerr conversion wave; main.ts
// imports this barrel once, so conversions never edit main.ts itself.
// Relative order mirrors the former js/plugin.js allComponentScripts seerr
// block; unconverted files still ride in via the legacy array appended by
// scripts/build-bundle.js.
import './seerr-status';
import './request-manager';
import './api';
import './seerr';
import './modal';
import './item-details';
import './issue-reporter';
import './seamless-scroll';
import './discovery/filter-utils';
import './discovery/base';
import './discovery/network';
import './discovery/person';
import './discovery/genre';
import './discovery/tag';
import './discovery/collection';
import './hss-discovery-handler';
import './more-info-modal/styles';
import './more-info-modal/data';
import './more-info-modal/seasons';
import './more-info-modal/badges';
import './more-info-modal/render';
import './more-info-modal/actions-tv';
import './more-info-modal/actions';
import './more-info-modal/init';
import './ui/icons';
import './ui/styles';
import './ui/popover';
import './ui/badges';
import './ui/cards';
import './ui/buttons';
import './ui/quota';
import './ui/results';
import './ui/request-modals';
import './ui/season-modal';
