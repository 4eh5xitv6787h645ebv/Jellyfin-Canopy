'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT_ROOT = path.join(ROOT, 'e2e', 'theme-studio-runtime.spec.ts-snapshots');
const DOC_IMAGE_ROOT = path.join(ROOT, 'docs', 'images');
const PRESETS = [
    ['canopy', 'Canopy'],
    ['minimal', 'Minimal'],
    ['cinematic', 'Cinematic'],
    ['glass', 'Glass'],
    ['material', 'Material'],
    ['studio', 'Studio'],
    ['focus', 'Focus'],
    ['oled', 'OLED'],
    ['high-contrast', 'High Contrast'],
];

function sourcePath(preset, view) {
    return path.join(SNAPSHOT_ROOT, `theme-studio-${preset}-${view}-linux.png`);
}

function requireSource(file) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error(`Verified Theme Studio snapshot is missing: ${path.relative(ROOT, file)}`);
    }
}

function copyVerifiedImages() {
    const copies = [
        ['canopy', 'desktop', 'theme-studio-home-desktop.png'],
        ['canopy', 'phone', 'theme-studio-home-phone.png'],
        ['focus', 'desktop', 'theme-studio-focus-desktop.png'],
        ['focus', 'phone', 'theme-studio-focus-phone.png'],
        ['oled', 'desktop', 'theme-studio-oled-desktop.png'],
        ['oled', 'phone', 'theme-studio-oled-phone.png'],
    ];
    for (const [preset, view, destination] of copies) {
        const source = sourcePath(preset, view);
        requireSource(source);
        fs.copyFileSync(source, path.join(DOC_IMAGE_ROOT, destination));
    }
}

function dataUrl(file) {
    return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
}

async function renderContactSheet(browser, view) {
    const phone = view === 'phone';
    const cards = PRESETS.map(([preset, label]) => {
        const source = sourcePath(preset, view);
        requireSource(source);
        return `<figure><img alt="" src="${dataUrl(source)}"><figcaption>${label}</figcaption></figure>`;
    }).join('');
    const width = phone ? 690 : 1200;
    const imageWidth = phone ? 180 : 360;
    const imageRatio = phone ? '390 / 844' : '1440 / 900';
    const page = await browser.newPage({
        viewport: { width: width + 64, height: phone ? 1500 : 1000 },
        deviceScaleFactor: 1,
        colorScheme: 'dark',
    });
    await page.setContent(`<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><style>
        * { box-sizing: border-box; }
        html, body { margin: 0; background: #08090e; color: #f4f5fb; }
        body { font-family: "DejaVu Sans", sans-serif; }
        #sheet { width: ${width + 64}px; padding: 32px; background: #08090e; }
        header { margin: 0 0 22px; }
        h1 { margin: 0; font-size: 28px; line-height: 1.2; }
        p { margin: 7px 0 0; color: #aeb2c4; font-size: 15px; }
        main { display: grid; grid-template-columns: repeat(3, ${imageWidth}px); gap: 20px; }
        figure { margin: 0; min-width: 0; overflow: hidden; border: 1px solid #34384a;
          border-radius: 14px; background: #12141d; box-shadow: 0 12px 32px rgba(0,0,0,.3); }
        img { display: block; width: 100%; aspect-ratio: ${imageRatio}; object-fit: cover;
          object-position: top left; background: #06070b; }
        figcaption { padding: 11px 13px 12px; font-size: 15px; font-weight: 750; }
      </style></head><body><section id="sheet"><header>
        <h1>Theme Studio presets · modern ${phone ? 'phone' : 'desktop'}</h1>
        <p>Nine verified presets on the synthetic Jellyfin 12 release fixture</p>
      </header><main>${cards}</main></section></body></html>`);
    await page.locator('#sheet').screenshot({
        path: path.join(DOC_IMAGE_ROOT, `theme-studio-presets-${view}.png`),
        animations: 'disabled',
        caret: 'hide',
    });
    await page.close();
}

async function main() {
    fs.mkdirSync(DOC_IMAGE_ROOT, { recursive: true });
    copyVerifiedImages();
    const browser = await chromium.launch({ headless: true });
    try {
        await renderContactSheet(browser, 'desktop');
        await renderContactSheet(browser, 'phone');
    } finally {
        await browser.close();
    }
    console.log('Generated verified Theme Studio documentation images.');
}

main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
