import { JC } from '../globals';
import type { FeatureModule, FeatureScope } from '../core/feature-loader';
import { installTagRendererBase } from '../core/tag-renderer-base';
import { installLiveRows } from '../core/live-rows';
import { installTagPipeline } from '../enhanced/tag-pipeline';
import { disposeGenreTags, installGenreTagsFacade } from './genretags';
import { installLanguageTagsFacade } from './languagetags';
import { installPeopleTagsFacade, resetPeopleTagsIdentity } from './peopletags';
import { installQualityTagsFacade } from './qualitytags';
import { installRatingTagsFacade } from './ratingtags';
import { installUserReviewTagsFacade, resetUserReviewTagsIdentity } from './userreviewtags';

const surface = JC as typeof JC & {
    initializeQualityTags?: () => void;
    initializeGenreTags?: () => void;
    initializeLanguageTags?: () => void;
    initializeRatingTags?: () => void;
    initializeUserReviewTags?: () => void;
    initializePeopleTags?: () => void;
};

export interface CardTagsEligibility {
    readonly posterTags: boolean;
    readonly peopleTags: boolean;
}

/** Snapshot the exact settings that justify loading this logical cluster. */
export function cardTagsEligibility(): CardTagsEligibility {
    const settings = JC.currentSettings;
    return {
        posterTags: settings?.qualityTagsEnabled === true
            || settings?.genreTagsEnabled === true
            || settings?.ratingTagsEnabled === true
            || settings?.languageTagsEnabled === true,
        peopleTags: settings?.peopleTagsEnabled === true,
    };
}

/** Base-runtime gate: all-disabled users must not request this feature entry. */
export function isCardTagsEnabled(): boolean {
    const eligibility = cardTagsEligibility();
    return eligibility.posterTags || eligibility.peopleTags;
}

/** People-only configurations wait for an item-details route. */
export function isCardTagsApplicable(routeKey: string): boolean {
    const eligibility = cardTagsEligibility();
    if (eligibility.posterTags) return true;
    const normalizedRoute = routeKey.toLowerCase();
    return eligibility.peopleTags
        && (normalizedRoute.includes('details') || normalizedRoute.includes('item'));
}

let activeClusterDispose: (() => void) | null = null;

async function activate(scope: FeatureScope): Promise<void> {
    if (!scope.isCurrent()) return;

    // A newer generation may enter while an older server-cache activation is
    // still awaiting I/O. Retire the old owner before touching singleton
    // facades/listeners so its eventual stale completion cannot tear down us.
    activeClusterDispose?.();

    const cleanups: Array<() => void> = [];
    let disposed = false;
    const dispose = (): void => {
        if (disposed) return;
        disposed = true;
        if (activeClusterDispose === dispose) activeClusterDispose = null;
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
            try { cleanups[index]?.(); } catch { /* continue cluster teardown */ }
        }
    };
    activeClusterDispose = dispose;
    scope.track(dispose);

    // Pipeline first: poster families register their renderers through this
    // stable facade. Every facade object/method survives later unload/re-enable.
    cleanups.push(installTagPipeline());
    cleanups.push(installTagRendererBase());
    cleanups.push(installGenreTagsFacade());
    cleanups.push(installLanguageTagsFacade());
    cleanups.push(installQualityTagsFacade());
    cleanups.push(installUserReviewTagsFacade());
    cleanups.push(installRatingTagsFacade());
    cleanups.push(installPeopleTagsFacade());
    cleanups.push(disposeGenreTags);
    cleanups.push(resetUserReviewTagsIdentity);
    cleanups.push(resetPeopleTagsIdentity);

    // Privacy-owned state is retired synchronously before the loader's async
    // generation reconciliation can install the next identity.
    const offIdentityReset = JC.identity.registerReset('card-tags-feature', dispose);
    cleanups.push(offIdentityReset);

    cleanups.push(installLiveRows());
    const eligibility = cardTagsEligibility();
    if (!scope.isCurrent()) {
        dispose();
        return;
    }

    // Install every frozen callable, but initialize only enabled families.
    if (JC.currentSettings?.qualityTagsEnabled === true) surface.initializeQualityTags?.();
    if (JC.currentSettings?.genreTagsEnabled === true) surface.initializeGenreTags?.();
    if (JC.currentSettings?.languageTagsEnabled === true) surface.initializeLanguageTags?.();
    if (JC.currentSettings?.ratingTagsEnabled === true) {
        surface.initializeUserReviewTags?.();
        surface.initializeRatingTags?.();
    }
    if (eligibility.peopleTags) surface.initializePeopleTags?.();

    if (eligibility.posterTags) {
        await Promise.resolve(JC.tagPipeline?.initialize?.());
    }
    if (!scope.isCurrent()) dispose();
}

/** Import-pure feature entry consumed by the generation-aware boot loader. */
export const cardTagsFeature: FeatureModule = { activate };
export { activate };
