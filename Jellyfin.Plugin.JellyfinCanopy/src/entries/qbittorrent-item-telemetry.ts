import type { FeatureScope } from '../core/feature-loader';
import { activateQbittorrentTelemetry } from '../qbittorrent/item-telemetry';

/** Import-pure qBittorrent details telemetry entry. */
export function activate(scope: FeatureScope): void {
    activateQbittorrentTelemetry(scope);
}
