// Real-browser geometry contract for custom DOM subtitles. This drives the
// installed Canopy runtime rather than restating its positioning algorithm in
// test code, then asks Chromium for the actual rendered boxes.
import { test, expect } from 'playwright/test';
import {
    applyCueGeometry,
    applySubtitleContainerGeometry,
} from '../Jellyfin.Plugin.JellyfinCanopy/src/enhanced/subtitle-geometry';

/* eslint-disable @typescript-eslint/no-explicit-any */

type CueGeometry = {
    mode: string;
    x: number;
    anchor: number;
    bottom: number;
    left: number;
    right: number;
    hostLeft: number;
    hostRight: number;
    lines: number;
};

test.describe('custom subtitle rendered geometry', () => {
    test('one-line, explicit multiline, and natural wraps keep one bottom edge and remain contained', async ({ page }) => {
        await page.setContent('<main id="fixture"></main>');
        const geometry = await page.evaluate<CueGeometry[], { cueSource: string; containerSource: string }>((sources) => {
            const applyCue = (0, eval)(`(${sources.cueSource})`) as (element: HTMLElement, xPct: number) => void;
            const applyContainer = (0, eval)(`(${sources.containerSource})`) as (
                container: HTMLElement,
                yPct: number,
            ) => void;
            const host = document.createElement('div');
            Object.assign(host.style, {
                position: 'fixed',
                left: '100px',
                top: '100px',
                width: '1000px',
                height: '500px',
                overflow: 'hidden',
            });
            const container = document.createElement('div');
            container.className = 'videoSubtitles';
            const inner = document.createElement('div');
            inner.className = 'videoSubtitlesInner';
            Object.assign(inner.style, {
                display: 'inline-block',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
                lineHeight: '20px',
            });
            container.appendChild(inner);
            host.appendChild(container);
            document.body.appendChild(host);

            const rows: CueGeometry[] = [];
            for (const [mode, text] of [
                ['one-line', 'A short subtitle'],
                ['explicit-two-line', 'First subtitle line\nSecond subtitle line'],
                ['natural-wrap', 'A deliberately long subtitle sentence that must naturally wrap inside the bounded cue box near both horizontal edges without escaping the video frame.'],
            ] as const) {
                for (const x of [10, 50, 90]) {
                    inner.textContent = text;
                    applyContainer(container, 85);
                    applyCue(inner, x);
                    const cue = inner.getBoundingClientRect();
                    const frame = host.getBoundingClientRect();
                    rows.push({
                        mode,
                        x,
                        anchor: frame.top + frame.height * 0.85,
                        bottom: cue.bottom,
                        left: cue.left,
                        right: cue.right,
                        hostLeft: frame.left,
                        hostRight: frame.right,
                        lines: Math.round(cue.height / 20),
                    });
                }
            }
            host.remove();
            return rows;
        }, {
            cueSource: applyCueGeometry.toString(),
            containerSource: applySubtitleContainerGeometry.toString(),
        });

        expect(geometry).toHaveLength(9);
        for (const row of geometry) {
            expect(Math.abs(row.bottom - row.anchor), `${row.mode} x=${row.x} bottom anchor`).toBeLessThanOrEqual(1);
            expect(row.left, `${row.mode} x=${row.x} left containment`).toBeGreaterThanOrEqual(row.hostLeft - 1);
            expect(row.right, `${row.mode} x=${row.x} right containment`).toBeLessThanOrEqual(row.hostRight + 1);
        }
        expect(geometry.filter(row => row.mode === 'explicit-two-line').every(row => row.lines >= 2)).toBe(true);
        expect(geometry.filter(row => row.mode === 'natural-wrap').every(row => row.lines >= 2)).toBe(true);
    });
});
