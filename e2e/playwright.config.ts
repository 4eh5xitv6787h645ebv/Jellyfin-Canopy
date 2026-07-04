// Playwright configuration for the committed E2E suite (e2e/*.spec.ts).
//
// The suite runs against a live Jellyfin 12 server with the plugin installed:
//   - locally: any dev server (default http://localhost:8099), e.g.
//       JF_BASE_URL=http://localhost:8099 npm run e2e
//   - CI: the dockerized seeded server from e2e/docker/ (see compose.yml).
//
// Imports come from 'playwright/test' (the runner re-exported by the
// `playwright` package) so the suite runs both against a globally installed
// `playwright` (NODE_PATH) and a CI-installed `@playwright/test` — the two
// packages ship the same runner.
//
// Specs are intentionally serial (workers: 1): they share one server's state
// (favorites, plugin config) and every spec restores what it touches.
import { defineConfig } from 'playwright/test';

export default defineConfig({
    testDir: __dirname,
    outputDir: `${__dirname}/test-results`,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    retries: 1,
    workers: 1,
    fullyParallel: false,
    reporter: [['list']],
    use: {
        baseURL: process.env.JF_BASE_URL || 'http://localhost:8099',
        viewport: { width: 1440, height: 900 },
        screenshot: 'only-on-failure',
        trace: 'retain-on-failure',
    },
});
