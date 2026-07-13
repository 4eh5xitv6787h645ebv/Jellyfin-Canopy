export interface GuardRestorePlan {
    readonly requiredGuarded: boolean;
    readonly restoreGuarded: boolean;
}

export function createGuardRestorePlan(
    initiallyGuarded: boolean,
    requiredGuarded: boolean
): Readonly<GuardRestorePlan>;
