import { defineConfig, devices } from '@playwright/test';

// Smoke test of the built single-file portal (dist-portal/index.html) opened via file://.
// Chromium is pre-installed under /opt/pw-browsers (never run `playwright install`).
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

export default defineConfig({
  testDir: './e2e',
  testMatch: /portal\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    locale: 'en-IE',
    timezoneId: 'Europe/Dublin',
  },
});
