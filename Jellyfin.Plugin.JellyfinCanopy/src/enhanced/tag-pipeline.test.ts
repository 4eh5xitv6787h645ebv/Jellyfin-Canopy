// issue 34: the tag pipeline is a poster-CARD decorator only — list-view rows must
// never receive card-sized tag overlays. isListViewRow is the single shared gate
// (used by shouldSkipElement, before any renderer runs) that excludes every
// `.listItem` row. These cases lock the gate's behaviour: a `.cardImageContainer`
// nested in a list row is a list row (skipped), a bare card is not, and the legacy
// no-image `.listItemImage.cardImageContainer` variant — the one shape the modern
// card scan selector could otherwise surface — is still caught.
import { describe, expect, it } from 'vitest';
import { isListViewRow } from './tag-pipeline';

/** Build a `.cardImageContainer` nested inside a `.listItem` row. */
function listRowImage(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'listItem';
    const img = document.createElement('div');
    img.className = 'cardImageContainer';
    row.appendChild(img);
    return img;
}

/** Build a bare poster-card `.cardImageContainer` (grid/home rail — should be tagged). */
function gridCardImage(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    const scalable = document.createElement('div');
    scalable.className = 'cardScalable';
    const img = document.createElement('div');
    img.className = 'cardImageContainer';
    scalable.appendChild(img);
    card.appendChild(scalable);
    return img;
}

/** Legacy no-image row: native renders the image element as `.listItemImage.cardImageContainer`. */
function legacyNoImageRow(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'listItem';
    const img = document.createElement('div');
    img.className = 'listItemImage cardImageContainer';
    row.appendChild(img);
    return img;
}

describe('isListViewRow — the single list-view gate (issue 34)', () => {
    it('treats a .cardImageContainer nested in a .listItem row as a list row (skipped)', () => {
        expect(isListViewRow(listRowImage())).toBe(true);
    });

    it('does NOT treat a bare poster-card .cardImageContainer as a list row (still tagged)', () => {
        expect(isListViewRow(gridCardImage())).toBe(false);
    });

    it('catches the legacy .listItemImage.cardImageContainer no-image variant', () => {
        expect(isListViewRow(legacyNoImageRow())).toBe(true);
    });
});
