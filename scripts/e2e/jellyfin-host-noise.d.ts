export const SCROLL_HANDLER_ERROR: 'pageerror: t.scrollHandler is not a function';
export const HOME_TAB_PREFIX: "[Home] failed to get tab controller TypeError: Cannot read properties of undefined (reading 'querySelector')";
export const HOME_SELECTED_INDEX_ERROR: "pageerror: Cannot read properties of undefined (reading 'selectedIndex')";
export const HOME_LOGOUT_AXIOS_401: 'AxiosError: Request failed with status code 401';

export function hasValidConcurrentLogoutResponses(
    responses: Array<{ requestIndex: number; status: number; bodyBytes: number }>
): boolean;
export function isKnownHiddenContentHostNoise(text: string): boolean;
export function isKnownJellyfinWebScrollHandlerError(
    detail: { text: string; stack?: string; source?: string }
): boolean;
export function isKnownJellyfinWebHostNoise(
    detail: { text: string; stack?: string; source?: string }
): boolean;
export function isExpectedSignedOutHostLogout4xx(
    response: { url: string; status: number; method: string },
    evidence: LogoutEvidence
): boolean;
export function isExpectedSignedOutHomeAxios401(
    detail: { text: string; url?: string; source?: string },
    evidence: LogoutEvidence,
    hasAllowedHost401: boolean
): boolean;

interface LogoutEvidence {
    origin: string;
    signedOut: {
        identityCleared: boolean;
        userId: string;
        oldUserId: string;
        route: string;
        cookie: string;
        initialized: boolean;
        pendingInitializations: number;
        initializationControllers: number;
        oldTokenStatus: number;
    };
}
