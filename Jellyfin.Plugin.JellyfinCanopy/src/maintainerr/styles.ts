import { JC } from '../globals';

const STYLE_ID = 'jc-maintainerr-page-styles';

const CSS = `
.jc-maintainerr-page {
    box-sizing: border-box;
    margin: 0 auto;
    max-width: 118rem;
    padding: 1rem clamp(.75rem, 2vw, 2rem) 4rem;
}
.jc-maintainerr-header,
.jc-maintainerr-header-actions,
.jc-maintainerr-status-line,
.jc-maintainerr-collection-meta,
.jc-maintainerr-pagination {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .65rem;
}
.jc-maintainerr-header {
    justify-content: space-between;
    margin-bottom: 1.25rem;
}
.jc-maintainerr-title { margin: 0; }
.jc-maintainerr-subtitle { margin: .3rem 0 0; opacity: .75; }
.jc-maintainerr-button,
.jc-maintainerr-link,
.jc-maintainerr-collection-open {
    align-items: center;
    border: 0;
    border-radius: .35rem;
    box-sizing: border-box;
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    gap: .35rem;
    min-height: 2.5rem;
    padding: .55rem .85rem;
    text-decoration: none;
}
.jc-maintainerr-button,
.jc-maintainerr-collection-open {
    background: var(--button-background, rgba(255,255,255,.12));
    color: inherit;
}
.jc-maintainerr-link {
    background: var(--primary-accent-color, #00a4dc);
    color: #fff;
}
.jc-maintainerr-button:focus-visible,
.jc-maintainerr-link:focus-visible,
.jc-maintainerr-collection-open:focus-visible {
    outline: .18rem solid var(--primary-accent-color, #00a4dc);
    outline-offset: .15rem;
}
.jc-maintainerr-status {
    border-left: .3rem solid #777;
    border-radius: .35rem;
    margin-bottom: 1.25rem;
    padding: 1rem;
    background: rgba(255,255,255,.06);
}
.jc-maintainerr-status.jc-state-ok { border-color: #52b54b; }
.jc-maintainerr-status.jc-state-warn { border-color: #ffb300; }
.jc-maintainerr-status.jc-state-error { border-color: #dc3545; }
.jc-maintainerr-status-title { font-size: 1.1rem; font-weight: 700; }
.jc-maintainerr-status-detail { margin-top: .45rem; opacity: .82; }
.jc-maintainerr-warning {
    align-items: flex-start;
    background: rgba(255,179,0,.12);
    border: 1px solid rgba(255,179,0,.6);
    border-radius: .4rem;
    display: flex;
    gap: .7rem;
    margin-bottom: 1.25rem;
    padding: .9rem 1rem;
}
.jc-maintainerr-warning strong {
    display: block;
    margin-bottom: .25rem;
}
.jc-maintainerr-section-state {
    background: rgba(255,255,255,.05);
    border-left: .25rem solid #777;
    border-radius: .35rem;
    margin: .7rem 0;
    padding: .75rem .85rem;
}
.jc-maintainerr-section-state.jc-state-partial { border-color: #ffb300; }
.jc-maintainerr-section-state.jc-state-unavailable { border-color: #dc3545; }
.jc-maintainerr-grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr));
    margin-bottom: 1.5rem;
}
.jc-maintainerr-rules-grid {
    display: grid;
    gap: .7rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 11rem), 1fr));
}
.jc-maintainerr-rules-grid .jc-maintainerr-metric {
    background: rgba(255,255,255,.04);
    padding: .8rem;
}
.jc-maintainerr-metric,
.jc-maintainerr-collection {
    background: rgba(255,255,255,.06);
    border: 1px solid rgba(255,255,255,.12);
    border-radius: .5rem;
    box-sizing: border-box;
    min-width: 0;
    padding: 1rem;
}
.jc-maintainerr-metric-label { opacity: .72; }
.jc-maintainerr-metric-value {
    font-size: 1.4rem;
    font-weight: 700;
    margin-top: .3rem;
    overflow-wrap: anywhere;
}
.jc-maintainerr-section { margin-top: 1.4rem; }
.jc-maintainerr-tabs {
    border-bottom: 1px solid rgba(255,255,255,.18);
    display: flex;
    gap: .35rem;
    margin-top: 1.4rem;
}
.jc-maintainerr-tab {
    background: transparent;
    border: 0;
    border-bottom: .2rem solid transparent;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-weight: 700;
    padding: .75rem .9rem;
}
.jc-maintainerr-tab[aria-selected="true"] {
    border-bottom-color: var(--primary-accent-color, #00a4dc);
    color: var(--primary-accent-color, #00a4dc);
}
.jc-maintainerr-tab:focus-visible {
    outline: .18rem solid var(--primary-accent-color, #00a4dc);
    outline-offset: -.1rem;
}
.jc-maintainerr-section-heading {
    align-items: end;
    display: flex;
    flex-wrap: wrap;
    gap: .8rem;
    justify-content: space-between;
    margin-bottom: .8rem;
}
.jc-maintainerr-section-heading h2 { margin: 0; }
.jc-maintainerr-controls {
    align-items: end;
    display: grid;
    gap: .7rem;
    grid-template-columns: minmax(12rem, 2fr) repeat(2, minmax(9rem, 1fr));
    margin: 0 0 1rem;
}
.jc-maintainerr-control {
    display: grid;
    font-size: .9rem;
    gap: .3rem;
}
.jc-maintainerr-control > span { opacity: .78; }
.jc-maintainerr-control input,
.jc-maintainerr-control select {
    background: rgba(0,0,0,.25);
    border: 1px solid rgba(255,255,255,.2);
    border-radius: .35rem;
    box-sizing: border-box;
    color: inherit;
    font: inherit;
    min-height: 2.5rem;
    padding: .5rem .65rem;
    width: 100%;
}
.jc-maintainerr-control input:focus-visible,
.jc-maintainerr-control select:focus-visible {
    outline: .18rem solid var(--primary-accent-color, #00a4dc);
    outline-offset: .12rem;
}
.jc-maintainerr-collection-title {
    font-size: 1.05rem;
    font-weight: 700;
    overflow-wrap: anywhere;
}
.jc-maintainerr-chip {
    background: rgba(255,255,255,.1);
    border-radius: 999px;
    display: inline-block;
    font-size: .82rem;
    max-width: 100%;
    overflow-wrap: anywhere;
    padding: .22rem .55rem;
}
.jc-maintainerr-chip.jc-active { background: rgba(82,181,75,.24); }
.jc-maintainerr-chip.jc-inactive { opacity: .65; }
.jc-maintainerr-collection-actions {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: .5rem;
    margin-top: .85rem;
}
.jc-maintainerr-records {
    display: grid;
    gap: .4rem;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
    margin: .75rem 0 0;
}
.jc-maintainerr-record {
    display: flex;
    gap: .5rem;
    justify-content: space-between;
    min-width: 0;
}
.jc-maintainerr-record dt {
    opacity: .75;
    overflow-wrap: anywhere;
}
.jc-maintainerr-record dd { margin: 0; font-weight: 700; }
.jc-maintainerr-empty,
.jc-maintainerr-error {
    background: rgba(255,255,255,.05);
    border-radius: .4rem;
    padding: 1rem;
}
.jc-maintainerr-error { border-left: .3rem solid #dc3545; }
.jc-maintainerr-modal {
    align-items: center;
    background: rgba(0,0,0,.72);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 1rem;
    position: fixed;
    z-index: 11000;
}
.jc-maintainerr-dialog {
    background: var(--theme-background-level-2, #202020);
    border-radius: .55rem;
    box-shadow: 0 .6rem 2rem rgba(0,0,0,.45);
    box-sizing: border-box;
    max-height: min(52rem, 90vh);
    max-width: 52rem;
    overflow: auto;
    padding: 1rem;
    width: 100%;
}
.jc-maintainerr-dialog-header {
    align-items: start;
    display: flex;
    gap: .75rem;
    justify-content: space-between;
}
.jc-maintainerr-dialog-header h2 { margin: .25rem 0 1rem; overflow-wrap: anywhere; }
.jc-maintainerr-content-list {
    display: grid;
    gap: .5rem;
    list-style: none;
    margin: 0;
    padding: 0;
}
.jc-maintainerr-content-item {
    align-items: center;
    background: rgba(255,255,255,.06);
    border-radius: .35rem;
    display: flex;
    gap: .7rem;
    justify-content: space-between;
    min-width: 0;
    padding: .7rem;
}
.jc-maintainerr-content-title { min-width: 0; overflow-wrap: anywhere; }
.jc-maintainerr-pagination { justify-content: space-between; margin-top: 1rem; }
@media (max-width: 40rem) {
    .jc-maintainerr-header-actions,
    .jc-maintainerr-header-actions > *,
    .jc-maintainerr-collection-actions,
    .jc-maintainerr-collection-actions > * {
        width: 100%;
    }
    .jc-maintainerr-button,
    .jc-maintainerr-link,
    .jc-maintainerr-collection-open { justify-content: center; }
    .jc-maintainerr-controls { grid-template-columns: 1fr; }
    .jc-maintainerr-content-item { align-items: stretch; flex-direction: column; }
}
`;

export function injectMaintainerrPageStyles(): void {
    JC.core.ui?.injectCss(STYLE_ID, CSS);
}

export function removeMaintainerrPageStyles(): void {
    JC.core.ui?.removeCss(STYLE_ID);
}
