import { test, expect, type Page } from '@playwright/test';

/** Screenshots of every main screen in mock mode (synthetic data only). */
const DIR = 'screenshots';

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('.loading')).toHaveCount(0);
  await page.waitForTimeout(400);
}
async function shot(page: Page, name: string) {
  await settle(page);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${DIR}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: 'serial' });

test('01 portfolio', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('heatmap')).toBeVisible();
  await shot(page, '01-portfolio');
});

test('02 controls index and detail', async ({ page }) => {
  await page.goto('/controls');
  await expect(page.getByRole('heading', { name: 'Controls' })).toBeVisible();
  await shot(page, '02-controls');
  await page.goto('/controls/EL1');
  await expect(page.getByTestId('control-rate')).toBeVisible();
  await expect(page.getByTestId('rate-bars')).toBeVisible();
  await shot(page, '03-control-detail');
});

test('04 exceptions', async ({ page }) => {
  await page.goto('/exceptions');
  await expect(page.getByTestId('exceptions-table')).toBeVisible();
  await shot(page, '04-exceptions');
});

test('05 matters and detail', async ({ page }) => {
  await page.goto('/matters');
  await expect(page.getByTestId('matters-table')).toBeVisible();
  await shot(page, '05-matters');
  await page.getByTestId('matters-table').locator('tbody tr').first().getByRole('link').click();
  await expect(page.getByTestId('control-results')).toBeVisible();
  await shot(page, '06-matter-detail');
});

test('07 key dates', async ({ page }) => {
  await page.goto('/key-dates?within=60');
  await expect(page.getByTestId('key-dates-table')).toBeVisible();
  await shot(page, '07-key-dates');
});

test('08 lexcel', async ({ page }) => {
  await page.goto('/lexcel');
  await page.getByLabel('Seed (optional)').fill('482913');
  await page.getByRole('button', { name: 'Generate sample' }).click();
  await expect(page.getByTestId('seed')).toHaveText('482913');
  await shot(page, '08-lexcel-sample');
});

test('09 settings', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByTestId('last-run')).toBeVisible();
  await shot(page, '09-settings');
});

test('10 sync in progress', async ({ page }) => {
  await page.goto('/settings?mock=syncing');
  await expect(page.getByTestId('sync-progress')).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${DIR}/10-sync-in-progress.png`, fullPage: true });
});

test('11 first run (no data)', async ({ page }) => {
  await page.goto('/?mock=empty');
  await expect(page.getByTestId('no-data')).toBeVisible();
  await shot(page, '11-first-run-empty');
});

test('12 device-code sign-in', async ({ page }) => {
  await page.goto('/settings?mock=device');
  await page.getByRole('button', { name: 'Sign in to iManage' }).click();
  await expect(page.getByTestId('device-code')).toBeVisible();
  await page.screenshot({ path: `${DIR}/12-sign-in-device-code.png`, fullPage: true });
});

test('13 session expired', async ({ page }) => {
  await page.goto('/?mock=expired');
  await expect(page.getByText('Session expired. Close this window and reopen the app.')).toBeVisible();
  await page.screenshot({ path: `${DIR}/13-session-expired.png`, fullPage: true });
});

test('14 error', async ({ page }) => {
  await page.goto('/?mock=error');
  await expect(page.getByRole('alert')).toBeVisible();
  await page.screenshot({ path: `${DIR}/14-error.png`, fullPage: true });
});

test('15 wipe confirmation', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Wipe local data…' }).click();
  await page.getByLabel('Type WIPE to confirm').fill('WIP');
  await page.screenshot({ path: `${DIR}/15-wipe-confirm.png` });
});

test.describe('dark mode', () => {
  test.use({ colorScheme: 'dark' });
  test('16 portfolio dark', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('heatmap')).toBeVisible();
    await shot(page, '16-portfolio-dark');
  });
  test('17 matter detail dark', async ({ page }) => {
    await page.goto('/matters');
    await page.getByTestId('matters-table').locator('tbody tr').first().getByRole('link').click();
    await expect(page.getByTestId('control-results')).toBeVisible();
    await shot(page, '17-matter-detail-dark');
  });
});
