import type { FeatureScope } from '../core/feature-loader';
import { hiddenContentPageDescriptor, hiddenContentPageFacade } from '../enhanced/hidden-content-page/page';
import { activateRoutePage } from '../enhanced/pages/route-feature';

/** Import-pure hidden-content management route entry. */
export function activate(scope: FeatureScope): void {
    activateRoutePage(scope, hiddenContentPageDescriptor, hiddenContentPageFacade);
}
