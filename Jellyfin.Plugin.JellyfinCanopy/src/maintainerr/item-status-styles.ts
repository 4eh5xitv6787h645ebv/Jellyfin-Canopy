import { JC } from '../globals';

const STYLE_ID = 'jc-maintainerr-item-status-styles';

export const MAINTAINERR_ITEM_STATUS_CSS = `
.jc-maintainerr-item-status-slot {
    align-items: center;
    block-size: 2.25rem;
    box-sizing: border-box;
    display: flex;
    flex: 1 1 100%;
    gap: .45em;
    max-inline-size: 100%;
    min-inline-size: 0;
    overflow: auto hidden;
    scrollbar-width: thin;
}
.jc-maintainerr-item-status-slot.jc-loading,
.jc-maintainerr-item-status-slot.jc-empty {
    visibility: hidden;
}
.jc-maintainerr-item-status-slot.jc-expanded {
    align-items: flex-start;
    block-size: min(14rem, 45vh);
    flex-wrap: wrap;
    overflow: auto;
}
.jc-maintainerr-item-status {
    align-items: center;
    display: inline-flex;
    gap: .3em;
    max-width: 100%;
}
.jc-maintainerr-item-status .material-icons {
    font-size: 1.05em;
}
.jc-maintainerr-item-status.jc-loading {
    min-height: 1.55em;
    min-width: 8.5em;
    opacity: .6;
}
.jc-maintainerr-item-status.jc-error {
    color: #ffb3b3;
}
.jc-maintainerr-item-status-details {
    background: rgba(255,255,255,.06);
    border-left: .22rem solid var(--primary-accent-color, #00a4dc);
    border-radius: .35rem;
    box-sizing: border-box;
    flex: 0 0 auto;
    max-width: min(52rem, 100%);
    padding: .35rem .55rem;
}
.jc-maintainerr-item-status-details > summary {
    cursor: pointer;
    font-weight: 700;
}
.jc-maintainerr-item-status-details-body {
    padding-top: .35rem;
}
.jc-maintainerr-item-status-row {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: .35rem;
    margin: .25rem 0;
}
.jc-maintainerr-item-status-label {
    font-weight: 700;
}
.jc-maintainerr-item-status-link,
.jc-maintainerr-item-status-name {
    background: rgba(255,255,255,.1);
    border-radius: 999px;
    color: inherit;
    display: inline-block;
    max-width: 100%;
    overflow-wrap: anywhere;
    padding: .15rem .5rem;
    text-decoration: none;
}
.jc-maintainerr-item-status-link:focus-visible {
    outline: .15rem solid var(--primary-accent-color, #00a4dc);
    outline-offset: .12rem;
}
`;

export function injectMaintainerrItemStatusStyles(): void {
    JC.core.ui?.injectCss(STYLE_ID, MAINTAINERR_ITEM_STATUS_CSS);
}

export function removeMaintainerrItemStatusStyles(): void {
    JC.core.ui?.removeCss(STYLE_ID);
}
