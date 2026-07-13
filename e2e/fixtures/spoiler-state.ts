import { api, type Session } from './api';
import {
    applyGuardRestorePlan,
    type GuardRestorePlan,
} from '../../scripts/e2e/spoiler-guard-restore';

/** Read the complete state so cleanup can preserve the target entry's metadata. */
export async function getSpoilerState(
    baseURL: string,
    session: Session
): Promise<Record<string, unknown>> {
    const state = await api<Record<string, unknown>>(
        baseURL,
        `/JellyfinCanopy/user-settings/${session.userId}/spoilerblur.json`,
        session.token
    );
    if (!state) throw new Error(`spoilerblur.json for ${session.userId} returned an empty body`);
    return state;
}

/** Restore one target entry into the latest state without rolling back unrelated fields. */
export async function restoreSeriesGuard(
    baseURL: string,
    session: Session,
    plan: GuardRestorePlan
): Promise<void> {
    const latest = await getSpoilerState(baseURL, session);
    await api(
        baseURL,
        `/JellyfinCanopy/user-settings/${session.userId}/spoilerblur.json`,
        session.token,
        {
            method: 'POST',
            body: JSON.stringify(applyGuardRestorePlan(latest, plan)),
        }
    );
}

/** Attempt every independent restore and expose cleanup failures after all finish. */
export async function restoreSeriesGuards(
    baseURL: string,
    entries: Array<{ session: Session; plan: GuardRestorePlan }>
): Promise<void> {
    const results = await Promise.allSettled(
        entries.map(({ session, plan }) => restoreSeriesGuard(baseURL, session, plan))
    );
    const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'multiple Spoiler Guard restores failed');
}
