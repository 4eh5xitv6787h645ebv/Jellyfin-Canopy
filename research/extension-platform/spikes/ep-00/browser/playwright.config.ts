// EP-00.2 spike config. Deliberately separate from e2e/playwright.config.ts so
// this throwaway spec can never be picked up by the required suite.
import { defineConfig } from 'playwright/test';

export default defineConfig({
    testDir: __dirname,
    timeout: 180_000,
    expect: { timeout: 30_000 },
    retries: 0,
    workers: 1,
    fullyParallel: false,
    reporter: [['list']],
    use: {
        baseURL: process.env.JF_BASE_URL || 'http://127.0.0.1:8100',
        viewport: { width: 1440, height: 900 },
        screenshot: 'only-on-failure',
        trace: 'off',
    },
});
