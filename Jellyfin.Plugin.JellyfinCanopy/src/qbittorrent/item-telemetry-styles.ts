const STYLE_ID = 'jc-qbittorrent-telemetry-styles';

export const QBITTORRENT_TELEMETRY_CSS = `
.jc-qbittorrent-telemetry-slot {
    align-items: center;
    block-size: 2.25rem;
    display: inline-flex;
    flex: 1 1 100%;
    gap: .5rem;
    min-inline-size: 0;
    overflow: auto hidden;
}
.jc-qbittorrent-telemetry-slot.jc-loading,
.jc-qbittorrent-telemetry-slot.jc-empty { visibility: hidden; }
.jc-qbittorrent-telemetry {
    align-items: center;
    background: color-mix(in srgb, var(--jf-palette-primary-main, #00a4dc) 16%, transparent);
    border-radius: 999px;
    display: inline-flex;
    gap: .35rem;
    max-inline-size: 100%;
    padding: .25rem .65rem;
    white-space: nowrap;
}
.jc-qbittorrent-telemetry .material-icons { font-size: 1.05rem; }
.jc-qbittorrent-telemetry-details { display: inline-flex; gap: .5rem; }
.jc-qbittorrent-telemetry-detail { color: var(--jf-palette-text-secondary, currentColor); }
.jc-qbittorrent-telemetry-error {
    background: color-mix(in srgb, var(--jf-palette-error-main, #f44336) 18%, transparent);
}
`;

export function injectQbittorrentTelemetryStyles(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = QBITTORRENT_TELEMETRY_CSS;
    document.head.appendChild(style);
}

export function removeQbittorrentTelemetryStyles(): void {
    document.getElementById(STYLE_ID)?.remove();
}
