export type AuthSessionPhase =
    | 'post-reload-session'
    | 'plugin-init'
    | 'current-user';

export type AuthSessionOutcome =
    | 'authenticated'
    | 'definite-bounce'
    | 'pending'
    | 'wrong-user'
    | 'stale-credentials';

export interface StoredSessionSummary {
    userId: string;
    hasToken: boolean;
}

export interface AuthSessionSnapshot {
    route: string;
    currentUserId: string;
    pluginInitialized: boolean;
    storedSessions: StoredSessionSummary[];
    credentialsMalformed?: boolean;
}

export interface AuthSessionDecision {
    outcome: AuthSessionOutcome;
    phase: AuthSessionPhase;
    diagnostic: string;
}

export type InitialConnectionOutcome =
    | 'authenticated'
    | 'pending'
    | 'sign-in';

export interface InitialConnectionDecision {
    outcome: InitialConnectionOutcome;
    diagnostic: string;
}

export interface InitialConnectionWaitOptions {
    timeoutMs: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
}

export interface InitialConnectionWaitResult extends InitialConnectionDecision {
    elapsedMs: number;
    timedOut: boolean;
}

export interface WaitOptions {
    timeoutMs: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
    stopOnPendingPhases?: AuthSessionPhase[];
}

export interface WaitResult extends AuthSessionDecision {
    elapsedMs: number;
    timedOut: boolean;
}

export const FAST_BOUNCE_TIMEOUT_MS: 8000;
export const INITIAL_CONNECTION_TIMEOUT_MS: 60000;
export const PLUGIN_INIT_TIMEOUT_MS: 60000;
export const CURRENT_USER_TIMEOUT_MS: 15000;
export const SESSION_POLL_INTERVAL_MS: 100;

export function classifyAuthSession(
    snapshot: AuthSessionSnapshot,
    expectedUserId: string
): AuthSessionDecision;

export function classifyInitialConnection(
    snapshot: AuthSessionSnapshot
): InitialConnectionDecision;

export function waitForInitialConnectionDecision(
    readSnapshot: () => Promise<AuthSessionSnapshot>,
    options: InitialConnectionWaitOptions
): Promise<InitialConnectionWaitResult>;

export function waitForSessionDecision(
    readSnapshot: () => Promise<AuthSessionSnapshot>,
    expectedUserId: string,
    options: WaitOptions
): Promise<WaitResult>;
