import type { FeatureScope } from '../core/feature-loader';
import { activateAwards } from '../awards/awards';

/** Import-pure awards details integration entry. */
export function activate(scope: FeatureScope): void {
    activateAwards(scope);
}
