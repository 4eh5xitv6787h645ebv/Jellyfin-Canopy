import { beforeEach, describe, expect, it } from 'vitest';
import { closeArrDropdowns } from './arr-links';

function dropdown(name: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'arr-dropdown open';
    wrapper.dataset.name = name;
    wrapper.innerHTML = '<a role="button" aria-haspopup="menu" aria-expanded="true"></a><div role="menu"></div>';
    document.body.appendChild(wrapper);
    return wrapper;
}

describe('ARR dropdown disclosure state', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    it('resets aria-expanded when a successor menu opens', () => {
        const previous = dropdown('previous');
        const current = dropdown('current');

        closeArrDropdowns(current);

        expect(previous.classList).not.toContain('open');
        expect(previous.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
        expect(current.classList).toContain('open');
        expect(current.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
    });

    it('resets every disclosure when an outside click closes the menus', () => {
        const first = dropdown('first');
        const second = dropdown('second');

        closeArrDropdowns();

        for (const menu of [first, second]) {
            expect(menu.classList).not.toContain('open');
            expect(menu.querySelector('[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
        }
    });
});
