export interface GuardRestorePlan {
    readonly requiredGuarded: boolean;
    readonly normalizedSeriesId: string;
    readonly originalKey: string | null;
    readonly originalEntry: Readonly<Record<string, unknown>> | null;
}

export function createGuardRestorePlan(
    initialState: Record<string, unknown>,
    seriesId: string,
    requiredGuarded: boolean
): Readonly<GuardRestorePlan>;

export function applyGuardRestorePlan(
    currentState: Record<string, unknown>,
    plan: Readonly<GuardRestorePlan>
): Record<string, unknown>;
