import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/**
 * Main user journey against the MSW mock (npm run dev:mock):
 * portfolio -> heatmap cell -> matter list -> matter detail -> Lexcel sample -> CSV export.
 */
test('portfolio to Lexcel sample and CSV export', async ({ page }) => {
  // Headless Chromium cannot answer the native "Save as" dialog, so use the
  // download fallback path of saveCsv() for this test.
  await page.addInitScript(() => {
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  const external: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol !== 'data:' && u.protocol !== 'blob:') external.push(r.url());
  });

  // 1. Portfolio
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeVisible();
  await expect(page.locator('.badge-mock').first()).toHaveText(/Demo data/);
  await expect(page.getByTestId('coverage')).toContainText('412 workspaces');
  await expect(page.getByTestId('last-synced')).toContainText('Last synced');
  await expect(page.getByTestId('kpi-readiness')).toContainText('%');

  // 2. Heatmap cell: Litigation x EL1
  const cell = page.getByTestId('heatmap').getByRole('button', { name: /^Litigation, EL1 / });
  await cell.click();

  // 3. Filtered matter list
  await expect(page).toHaveURL(/\/matters\?/);
  await expect(page).toHaveURL(/practice_area=Litigation/);
  await expect(page).toHaveURL(/failing_control=EL1/);
  await expect(page.getByLabel('Practice area')).toHaveValue('Litigation');
  await expect(page.getByLabel('Failing control')).toHaveValue('EL1');
  const rows = page.getByTestId('matters-table').locator('tbody tr');
  await expect(rows.first()).toBeVisible();
  await expect(rows.first()).toContainText('EL1');

  // 4. Matter detail
  const firstLink = rows.first().getByRole('link');
  const code = (await firstLink.textContent())!.split(' · ')[0]!;
  await firstLink.click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
  await expect(page.getByTestId('control-results')).toContainText('EL1');
  await expect(page.getByTestId('timeline')).toContainText('Workspace created');

  // 5. Lexcel sample with a fixed seed is reproducible
  await page.getByRole('link', { name: 'Lexcel sampling' }).click();
  await page.getByLabel('Matters per fee earner').fill('2');
  await page.getByLabel('Seed (optional)').fill('12345');
  await page.getByRole('button', { name: 'Generate sample' }).click();
  await expect(page.getByTestId('seed')).toHaveText('12345');
  const firstRun = await page.getByTestId('lexcel-table').innerText();
  await page.getByRole('button', { name: 'Generate sample' }).click();
  await expect(page.getByTestId('seed')).toHaveText('12345');
  expect(await page.getByTestId('lexcel-table').innerText()).toBe(firstRun);

  // 6. CSV export
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^lexcel-sample-seed-12345-\d{8}-\d{4}\.csv$/);
  const csv = await readFile((await download.path())!, 'utf8');
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r\n/);
  expect(lines[0]).toBe('seed,per_fee_earner,generated_at,fee_earner,matter_code,matter_name,client_name,practice_area,partner,opened,risk_score,failing_controls');
  expect(lines.length).toBeGreaterThan(10);
  expect(lines[1]).toMatch(/^12345,2,/);

  expect(external, 'no external network requests').toEqual([]);
});
