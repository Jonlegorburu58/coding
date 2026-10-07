import { defineConfig, devices } from '@playwright/test';

// Chromium is pre-installed under /opt/pw-browsers (never run `playwright install`).
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '/opt/pw-browsers';

const PORT = 5174;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
    colorScheme: 'light',
    locale: 'en-IE',
    timezoneId: 'Europe/Dublin',
    launchOptions: { args: ['--lang=en-IE'] },
  },
  projects: [
    { name: 'e2e', testMatch: /journey\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/, use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'npm run dev:mock',
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
