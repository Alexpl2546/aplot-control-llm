import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'mobile.e2e.ts',
  workers: 1,
  timeout: 90_000,
  reporter: 'list',
  outputDir: 'artifacts/mobile/playwright-results',
  use: { headless: true, trace: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', channel: 'chrome' }, grepInvert: /WebKit mobile commands/ },
    { name: 'webkit', use: { browserName: 'webkit' }, grep: /WebKit mobile commands/ },
  ],
});
