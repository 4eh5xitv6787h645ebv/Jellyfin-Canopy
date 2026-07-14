export const SCROLL_HANDLER_ERROR: 'pageerror: t.scrollHandler is not a function';
export const HOME_TAB_PREFIX: "[Home] failed to get tab controller TypeError: Cannot read properties of undefined (reading 'querySelector')";
export const HOME_SELECTED_INDEX_ERROR: "pageerror: Cannot read properties of undefined (reading 'selectedIndex')";

export function isKnownHiddenContentHostNoise(text: string): boolean;
export function isKnownJellyfinWebHostNoise(detail: { text: string; stack?: string }): boolean;
