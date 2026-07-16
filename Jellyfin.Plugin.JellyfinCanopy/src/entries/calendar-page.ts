import type { FeatureScope } from '../core/feature-loader';
import { calendarPageDescriptor, calendarPageFacade } from '../arr/calendar/page';
import { activateRoutePage } from '../enhanced/pages/route-feature';

/** Import-pure calendar route entry. */
export function activate(scope: FeatureScope): void {
    activateRoutePage(scope, calendarPageDescriptor, calendarPageFacade);
}
