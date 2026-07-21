// Playwright configuration for the committed E2E suite (e2e/*.spec.ts).
//
// The suite runs against a live Jellyfin 12 server with the plugin installed:
//   - locally: any dev server (default http://localhost:8099), e.g.
//       JF_BASE_URL=http://localhost:8099 npm run e2e
//   - CI: the dockerized seeded server from e2e/docker/ (see compose.yml).
//
// Imports come from 'playwright/test' (the runner re-exported by the
// `playwright` dependency installed with `@playwright/test`).
//
// Specs are intentionally serial (workers: 1): they share one server's state
// (favorites, plugin config) and every spec restores what it touches.
import { defineConfig } from 'playwright/test';

const outputDir = process.env.JF_E2E_OUTPUT_DIR?.trim() || `${__dirname}/test-results`;
const required = process.env.JF_E2E_REQUIRED === 'true';
const ci = process.env.CI === 'true';
// Traces contain DOM snapshots, request metadata and evaluated arguments. Keep
// them available for explicit local debugging, but never retain them in CI or
// the required evidence matrix. CI publishes bounded screenshots only.
const trace = required || ci || process.env.JF_E2E_TRACE === 'off' ? 'off' : 'retain-on-failure';
const requiredReporter = required
    ? [['list'], [`${__dirname}/../scripts/e2e/required-inventory-reporter.js`]]
    : [['list']];

export default defineConfig({
    testDir: __dirname,
    outputDir,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    retries: required ? 0 : 1,
    workers: 1,
    fullyParallel: false,
    reporter: requiredReporter,
    use: {
        baseURL: process.env.JF_BASE_URL || 'http://localhost:8099',
        viewport: { width: 1440, height: 900 },
        screenshot: 'only-on-failure',
        trace,
    },
});
