// Unit tests for src/seerr/more-info-modal/render.ts — XSS escaping of
// Seerr/TMDB payload fields in the modal body builders (poster src / alt,
// backdrop style URL, title text) after the escaping sweep.
//
// A hostile field like '"><img src=x onerror=alert(1)>' must render inert:
// escaped into attribute/text positions without injecting any element.
import { beforeAll, describe, expect, it } from 'vitest';
import { JC } from '../../globals';
// ui-kit must load before the modal builders: it installs the real
// JC.escapeHtml (the test setup stub is a no-op) which render.ts captures
// at import.
import '../../core/ui-kit';
import { internal } from './internal';
// Side-effect imports register the builders used by buildModalContent on the
// shared `internal` bag (getContentRating/formatCurrency and buildMediaFacts).
import './data';
import './badges';
import './render';

const HOSTILE = '"><img src=x onerror=alert(1)>';

function renderToDom(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host;
}

describe('buildModalContent escaping', () => {
    beforeAll(() => {
        // The builders resolve labels at call time; the setup stub has no t().
        (JC as { t?: (key: string) => string }).t = (key: string) => key;
    });

    it('renders hostile posterPath/backdropPath/title inert (no element injection)', () => {
        const data = {
            title: HOSTILE,
            posterPath: HOSTILE,
            backdropPath: HOSTILE,
            status: HOSTILE,
        };

        const host = renderToDom(internal.buildModalContent(data, 'movie'));

        // No injected <img src="x"> and no injected onerror handler anywhere.
        expect(host.querySelector('img[src="x"]')).toBeNull();
        expect(host.querySelectorAll('[onerror]').length).toBe(0);

        // Poster: exactly one img in the header, payload confined to the src value.
        const posterImgs = host.querySelectorAll<HTMLImageElement>('.header-poster img');
        expect(posterImgs.length).toBe(1);
        expect(posterImgs[0].getAttribute('src')).toBe(`https://image.tmdb.org/t/p/w500${HOSTILE}`);
        expect(posterImgs[0].getAttribute('alt')).toBe(HOSTILE);

        // Backdrop: payload stays inside the style attribute value.
        const backdrop = host.querySelector<HTMLElement>('.modal-backdrop')!;
        expect(backdrop.children.length).toBe(1); // only the overlay div
        expect(backdrop.getAttribute('style')).toContain('background-image');

        // Title renders the payload as text with no child elements.
        const title = host.querySelector('.title')!;
        expect(title.textContent).toContain(HOSTILE);
        expect(title.querySelector('img')).toBeNull();

        // Status stat value renders as text.
        const statValues = host.querySelectorAll('.jc-more-info-stat-value');
        expect(statValues[0].textContent).toBe(HOSTILE);
        expect(statValues[0].children.length).toBe(0);
    });

    it('escapes hostile trailer and cast payload fields', () => {
        const data = {
            title: 'Safe',
            relatedVideos: [
                { type: 'Trailer', site: 'YouTube', key: HOSTILE, name: HOSTILE, url: 'https://youtu.be/x' },
            ],
            credits: {
                cast: [{ name: HOSTILE, character: HOSTILE, profilePath: HOSTILE }],
            },
        };

        const host = renderToDom(internal.buildModalContent(data, 'movie'));

        expect(host.querySelector('img[src="x"]')).toBeNull();
        expect(host.querySelectorAll('[onerror]').length).toBe(0);

        const thumb = host.querySelector<HTMLImageElement>('.trailer-thumbnail img')!;
        expect(thumb.getAttribute('src')).toBe(`https://img.youtube.com/vi/${HOSTILE}/mqdefault.jpg`);
        const trailerName = host.querySelector('.trailer-name')!;
        expect(trailerName.textContent).toBe(HOSTILE);
        expect(trailerName.children.length).toBe(0);

        const castImg = host.querySelector<HTMLImageElement>('.person-avatar img')!;
        expect(castImg.getAttribute('src')).toBe(`https://image.tmdb.org/t/p/w185${HOSTILE}`);
        const personName = host.querySelector('.person-name')!;
        expect(personName.textContent).toBe(HOSTILE);
        expect(personName.children.length).toBe(0);
    });
});
