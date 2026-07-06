// MISC-3: the Segment Editor plugin-icon selector had a typo `Segment%Editor`
// (missing the URL-encoded space) while every other entry encodes it `%20`. The
// real dashboard href contains `Segment%20Editor`, so the substring selector
// never matched and the icon was never replaced.
//
// This drives the ACTUAL selector literal from the source against a real
// Segment Editor anchor, so the test is red until the source encodes the space.
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(HERE, 'plugin-icons.ts'), 'utf8');

describe('plugin-icons Segment Editor selector (MISC-3)', () => {
    it('uses the URL-encoded space so it matches the real Segment Editor href', () => {
        // Pull the Segment Editor selector literal straight out of the source.
        const m = src.match(/selector:\s*'(a\[href\*="Segment[^"]*Editor"\])'/);
        expect(m, 'Segment Editor icon selector not found in plugin-icons.ts').not.toBeNull();
        const selector = m![1];

        // The dashboard link encodes the space in the plugin name as %20.
        const link = document.createElement('a');
        link.setAttribute('href', 'https://host/web/#!/configurationpage?name=Segment%20Editor');
        document.body.appendChild(link);

        expect(document.querySelector(selector)).toBe(link);
        expect(selector).toContain('Segment%20Editor');
        document.body.innerHTML = '';
    });
});
