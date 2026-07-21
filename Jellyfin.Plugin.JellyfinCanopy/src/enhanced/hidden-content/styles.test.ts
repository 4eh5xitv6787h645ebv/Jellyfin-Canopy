// Regression coverage for the detail ribbon containment rules (issue #454):
// the Hide button adds a sixth in-flow button to the native detail action
// row, and without a containment rule the row's automatic minimum size
// (min-width: auto) pushes document scrollWidth past a 390px viewport.
// The fix must lift the floor of the row and of OUR button only — native
// .detailButton siblings must keep their intrinsic sizing.
import { afterEach, describe, expect, it } from 'vitest';
import '../../core/ui-kit'; // publishes JC.core.ui.injectCss, the sink addCSS uses
import { injectCSS } from './styles';

const STYLE_ID = 'jc-hidden-content';

function styleRules(): CSSStyleRule[] {
    const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style?.sheet) return [];
    return [...style.sheet.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
}

afterEach(() => {
    document.getElementById(STYLE_ID)?.remove();
});

describe('hidden-content detail ribbon containment (issue #454)', () => {
    it('lifts the min-width floor of a ribbon row only while it holds the Hide button', () => {
        injectCSS();

        const rowRule = styleRules().find(rule =>
            rule.selectorText.includes(':has(> .jc-detail-hide-btn)')
            && rule.style.minWidth === '0px');
        expect(rowRule, 'row containment rule gated on the Hide button').toBeTruthy();
        // Every container addHideContentButton can mount into is covered.
        for (const container of ['.mainDetailButtons', '.detailButtons', '.itemActionsBottom', '.detailButtonsContainer']) {
            expect(rowRule!.selectorText).toContain(container);
        }
        // The gate is the button's presence: every min-width lift that can
        // reach a ribbon container must carry the :has(> .jc-detail-hide-btn)
        // gate. An ungated `.mainDetailButtons { min-width: 0 }` (or any
        // sibling container) would restyle untouched native rows — the exact
        // native-look regression this suite guards against.
        const ungatedRowLift = styleRules().some(rule =>
            rule.style.minWidth === '0px'
            && /\.(mainDetailButtons|detailButtons|itemActionsBottom|detailButtonsContainer)(?![\w-])/.test(rule.selectorText)
            && !rule.selectorText.includes(':has(> .jc-detail-hide-btn)'));
        expect(ungatedRowLift, 'ribbon-row min-width lifts must be gated on the Hide button').toBe(false);
    });

    it('compresses only the Canopy Hide button, never native detail buttons', () => {
        injectCSS();

        const rules = styleRules();
        expect(rules.some(rule => rule.selectorText === '.jc-detail-hide-btn'
            && rule.style.minWidth === '0px')).toBe(true);
        // No rule may lift the min-content floor of native .detailButton
        // siblings — squeezing native buttons below intrinsic size is the
        // exact native-look regression the fix must avoid.
        expect(rules.some(rule => rule.style.minWidth === '0px'
            && /(^|[^.\w-])\.detailButton(?![\w-])/.test(rule.selectorText))).toBe(false);
    });

    it('injects once: repeated calls never duplicate the stylesheet', () => {
        injectCSS();
        injectCSS();
        expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    });
});
