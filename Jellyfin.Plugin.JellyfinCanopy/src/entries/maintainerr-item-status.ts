import type { FeatureScope } from '../core/feature-loader';
import { activateMaintainerrItemStatus } from '../maintainerr/item-status';

/** Import-pure Maintainerr details integration entry. */
export function activate(scope: FeatureScope): void {
    activateMaintainerrItemStatus(scope);
}
