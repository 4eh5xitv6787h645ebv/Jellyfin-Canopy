import type { FeatureScope } from '../core/feature-loader';
import { bookmarksPageDescriptor, bookmarksPageFacade } from '../enhanced/bookmarks/page';
import { activateRoutePage } from '../enhanced/pages/route-feature';

/** Import-pure bookmarks-management route entry. */
export function activate(scope: FeatureScope): void {
    activateRoutePage(scope, bookmarksPageDescriptor, bookmarksPageFacade);
}
