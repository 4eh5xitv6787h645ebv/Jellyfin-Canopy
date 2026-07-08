// src/discovery/index.ts
//
// Discovery / Trending area barrel. main.ts imports this once. The feed engine (rows/data/feed) is
// placement-agnostic; this barrel wires the first placement — the Movies/TV library page tab.
// Follow-up placements (home tab, standalone page, search suggestions) register alongside it.
import { initLibraryTab } from './library-tab';

initLibraryTab();
