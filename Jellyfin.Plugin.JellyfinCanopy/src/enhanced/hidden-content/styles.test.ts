// Regression coverage for Hidden Content's detail-row containment (issue #454):
// the injected detail Hide button adds a sixth in-flow button to the native
// no-wrap action row, and on a 390px viewport the widened row's min-content
// pushed document scrollWidth past the viewport (horizontal page overflow —
// the no-jank class the R-rules forbid for injected UI). The remedy must let
// ONLY a row holding our button wrap; it must never compress our button below
// its intrinsic icon/tap-target size and never restyle rows without our button.
import { afterEach, describe, expect, it } from 'vitest';
import '../../core/ui-kit'; // publishes JC.core.ui.injectCss, the sink addCSS uses
import { injectCSS } from './styles';

const STYLE_ID = 'jc-hidden-content';

function styleRules(): CSSStyleRule[] {
    const style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style?.sheet) return [];
    return [...style.sheet.cssRules].filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule);
}

const RIBBON_CONTAINER = /\.(mainDetailButtons|detailButtons|itemActionsBottom|detailButtonsContainer)(?![\w-])/;

afterEach(() => {
    document.getElementById(STYLE_ID)?.remove();
});

describe('hidden-content detail row containment (issue #454)', () => {
    it('lets a detail row wrap only while it holds the Hide button', () => {
        injectCSS();

        const rowRule = styleRules().find(rule =>
            rule.selectorText.includes(':has(> .jc-detail-hide-btn)')
            && rule.style.flexWrap === 'wrap');
        expect(rowRule, 'wrap rule gated on the Hide button').toBeTruthy();
        // Every container addHideContentButton can mount into is covered.
        for (const container of ['.mainDetailButtons', '.detailButtons', '.itemActionsBottom', '.detailButtonsContainer']) {
            expect(rowRule!.selectorText).toContain(container);
        }
        // The gate is the button's presence: every rule that can reach a
        // ribbon container must carry the :has(> .jc-detail-hide-btn) gate.
        // An ungated `.mainDetailButtons { … }` (or any sibling container)
        // would restyle untouched native rows — the exact native-look
        // regression this suite guards against.
        const ungatedRowRestyle = styleRules().some(rule =>
            RIBBON_CONTAINER.test(rule.selectorText)
            && !rule.selectorText.includes(':has(> .jc-detail-hide-btn)'));
        expect(ungatedRowRestyle, 'ribbon-container rules must be gated on the Hide button').toBe(false);
    });

    it('never compresses the Hide button or native detail buttons below intrinsic size', () => {
        injectCSS();

        // No rule may lift the min-content floor of the Canopy Hide button or
        // of native .detailButton siblings: a `min-width: 0` (or forced
        // shrink) lets the flex algorithm squeeze a 45px icon button below its
        // icon/tap target — the accessibility regression the adversarial
        // review rejected. Containment comes from the gated wrap rule alone.
        for (const rule of styleRules()) {
            const touchesDetailButton = /(^|[^.\w-])\.(jc-detail-hide-btn|detailButton)(?![\w-])/.test(rule.selectorText);
            if (!touchesDetailButton) continue;
            expect(rule.style.minWidth, `min-width in "${rule.selectorText}"`).toBe('');
            expect(rule.style.flexShrink, `flex-shrink in "${rule.selectorText}"`).toBe('');
            expect(rule.style.flex, `flex in "${rule.selectorText}"`).toBe('');
            expect(rule.style.maxWidth, `max-width in "${rule.selectorText}"`).toBe('');
        }
    });

    it('injects once: repeated calls never duplicate the stylesheet', () => {
        injectCSS();
        injectCSS();
        expect(document.querySelectorAll(`#${STYLE_ID}`)).toHaveLength(1);
    });
});
