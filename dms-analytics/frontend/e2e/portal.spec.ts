import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { utils, write } from 'xlsx';
import { generateSampleExport } from '../src/portal/sample';

/**
 * Smoke test of the built single-file portal opened from disk (file://):
 * sample export -> column mapping -> type mapping -> dashboard -> matter detail,
 * then uploads of a generated (fictional) .xlsx and .csv through the file inputs.
 * Fails on any console error, page error or request that is not file:/data:.
 */
const PAGE = pathToFileURL(resolve('dist-portal/index.html')).href;
const SHOTS = 'screenshots';
const TMP = resolve('test-results/portal-fixtures');

function watch(page: Page) {
  const problems: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${String(e)}`));
  page.on('request', (r) => {
    const p = new URL(r.url()).protocol;
    if (p !== 'file:' && p !== 'data:') problems.push(`request: ${r.url()}`);
  });
  return problems;
}

async function shot(page: Page, name: string, fullPage = true) {
  await expect(page.locator('.loading')).toHaveCount(0);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

/** Fictional uploads built from the sample generator, with differently named headers. */
function makeFixtures() {
  mkdirSync(TMP, { recursive: true });
  const now = Date.UTC(2026, 9, 7, 12, 0, 0);
  const s = generateSampleExport(now, 24, 77);
  const parse = (v: string) => {
    const [d, t] = v.split(' ');
    const [dd, mm, yy] = d!.split('/').map(Number);
    const [h, mi] = (t ?? '00:00').split(':').map(Number);
    return new Date(yy!, mm! - 1, dd!, h, mi);
  };
  // .xlsx: real Excel date cells (serial numbers), iManage-style headers.
  const xlsxHeaders = ['Doc Number', 'Version', 'Description', 'Class', 'Sub Class', 'Author', 'Operator', 'Created', 'Edited', 'Client', 'Matter', 'Workspace', 'Folder'];
  const aoa = [xlsxHeaders, ...s.docs.rows.map((r) => r.map((c, i) => (i === 7 || i === 8 ? parse(String(c)) : c)))];
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet([['Search results (fictional)'], [], ...aoa], { cellDates: true }), 'Results');
  writeFileSync(join(TMP, 'fictional-documents.xlsx'), write(wb, { type: 'buffer', bookType: 'xlsx' }));
  // Matter list as CSV with dd/mm/yyyy dates.
  const csv = (rows: unknown[][]) => rows.map((r) => r.map((c) => (c === null ? '' : `"${String(c).replace(/"/g, '""')}"`)).join(',')).join('\r\n');
  writeFileSync(join(TMP, 'fictional-matters.csv'), csv([s.matters.headers, ...s.matters.rows]));
  // Document list as CSV only (no matter list), with other header spellings.
  const csvHeaders = ['Number', 'Version', 'Document Name', 'Class', 'Subclass', 'Author', 'Last Edited By', 'Date Created', 'Last Modified', 'Client Number', 'Matter Number', 'Workspace Name', 'Path'];
  writeFileSync(join(TMP, 'fictional-documents.csv'), '\uFEFF' + csv([csvHeaders, ...s.docs.rows]));
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
  makeFixtures();
});

test('portal: sample export to dashboard and matter detail, offline', async ({ page }) => {
  const problems = watch(page);
  await page.goto(PAGE);
  await expect(page.getByRole('heading', { name: 'Import an iManage export', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/#\/import$/);
  await expect(page.getByText('No file imported')).toBeVisible();
  await shot(page, 'portal-import');

  await page.getByTestId('load-sample').click();
  await expect(page.getByTestId('map-docs')).toBeVisible();
  await expect(page.getByLabel('Created date')).toHaveValue('Create Date');
  await expect(page.getByTestId('map-docs-date-stats')).toContainText('Created date: 0 of');
  await expect(page.getByTestId('map-docs-preview').locator('tbody tr')).toHaveCount(5);
  await shot(page, 'portal-column-mapping');

  await page.getByTestId('to-types').click();
  await expect(page.getByTestId('type-mapping')).toBeVisible();
  await expect(page.getByLabel('FILEOPEN', { exact: true })).toHaveValue('file_opening');
  await shot(page, 'portal-type-mapping');

  await page.getByTestId('run-import').click();
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeVisible();
  await expect(page.getByTestId('coverage')).toContainText('Held only in this browser tab');
  await expect(page.getByTestId('coverage')).toContainText('150 matters');
  await expect(page.getByText('Sample file (fictional)')).toBeVisible();
  await expect(page.getByTestId('heatmap')).toBeVisible();
  await expect(page.getByTestId('single-snapshot')).toContainText('Trend needs more than one import');
  await expect(page.getByRole('button', { name: /Export CSV/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Copy as CSV/ }).first()).toBeVisible();
  await shot(page, 'portal-dashboard');

  // Copy as CSV: clipboard, or the select-text fallback where the browser refuses.
  await page.getByRole('button', { name: /Copy as CSV/ }).first().click();
  await expect(page.getByText(/Copied \d+ rows as CSV/).or(page.getByTestId('copy-panel'))).toBeVisible();
  if (await page.getByTestId('copy-panel').isVisible()) await page.getByRole('button', { name: 'Done' }).click();

  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Matters', exact: true }).click();
  await expect(page.getByTestId('matters-table')).toBeVisible();
  await page.getByTestId('matters-table').locator('tbody tr a').first().click();
  await expect(page.getByTestId('control-results')).toBeVisible();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await shot(page, 'portal-matter-detail');

  await page.setViewportSize({ width: 400, height: 860 });
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Portfolio', exact: true }).click();
  await expect(page.getByTestId('kpi-readiness')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, 'portal-400', false);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByTestId('clear-data').click();
  await expect(page).toHaveURL(/#\/import$/);
  await expect(page.getByText('No file imported')).toBeVisible();
  expect(problems).toEqual([]);
});

test('portal: upload a fictional .xlsx document list and .csv matter list', async ({ page }) => {
  const problems = watch(page);
  await page.goto(PAGE);
  await page.getByLabel('Document list file').setInputFiles(join(TMP, 'fictional-documents.xlsx'));
  await expect(page.getByTestId('drop-docs')).toContainText('fictional-documents.xlsx');
  await page.getByLabel('Matter list file').setInputFiles(join(TMP, 'fictional-matters.csv'));
  await expect(page.getByTestId('drop-matters')).toContainText('fictional-matters.csv');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('map-docs').getByLabel('Created date')).toHaveValue('Created');
  await expect(page.getByTestId('map-docs').getByLabel('Document name')).toHaveValue('Description');
  await expect(page.getByTestId('map-docs-date-stats')).toContainText('Created date: 0 of');
  await expect(page.getByTestId('map-matters').getByLabel('Key date')).toHaveValue('Key Date');
  await expect(page.getByTestId('map-matters-date-stats')).toContainText('Open date: 0 of 24');
  await page.getByTestId('to-types').click();
  await page.getByTestId('run-import').click();
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeVisible();
  await expect(page.getByText('Imported file', { exact: true })).toBeVisible();
  await expect(page.getByTestId('coverage')).toContainText('24 matters');
  await expect(page.getByTestId('coverage')).toContainText('fictional-documents.xlsx');
  // Only the mapping settings may be stored; no rows, names or other browser storage.
  const stored = await page.evaluate(async () => ({
    local: Object.fromEntries(Object.keys(window.localStorage).map((k) => [k, window.localStorage.getItem(k)])),
    session: window.sessionStorage.length,
    idb: (await indexedDB.databases()).length,
  }));
  expect(Object.keys(stored.local)).toEqual(['bws-dms-portal-settings-v1']);
  const settingsText = stored.local['bws-dms-portal-settings-v1']!;
  expect(settingsText).toContain('"created": "Created"'.replace(': ', ':'));
  expect(settingsText).not.toMatch(/Example|Sample Holdings|Partner [A-Z]|Fee Earner [A-Z]|C100\d\d|Letter of engagement/);
  expect(stored.session).toBe(0);
  expect(stored.idb).toBe(0);
  expect(problems).toEqual([]);
});

test('portal: upload a fictional .csv document list on its own', async ({ page }) => {
  const problems = watch(page);
  await page.goto(PAGE);
  await page.getByLabel('Document list file').setInputFiles(join(TMP, 'fictional-documents.csv'));
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByTestId('map-docs').getByLabel('Created date')).toHaveValue('Date Created');
  await expect(page.getByTestId('map-docs').getByLabel('Client', { exact: true })).toHaveValue('Client Number');
  await page.getByTestId('to-types').click();
  await expect(page.getByTestId('unknown-controls')).toContainText('CD1');
  await page.getByTestId('run-import').click();
  await expect(page.getByRole('heading', { name: 'Portfolio', level: 1 })).toBeVisible();
  await expect(page.getByTestId('coverage')).toContainText('24 matters');
  await page.getByTestId('coverage').getByText(/About this import/).click();
  await expect(page.getByTestId('coverage')).toContainText('No matter list was imported');
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Controls', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Controls', level: 1 })).toBeVisible();
  expect(problems).toEqual([]);
});
