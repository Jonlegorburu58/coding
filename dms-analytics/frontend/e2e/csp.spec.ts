import { test, expect } from '@playwright/test';

/** The built app must run under the strict CSP with no violations and no external requests. */
test('built bundle runs under the strict CSP', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy|Refused/i.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !['data:', 'blob:'].includes(u.protocol)) problems.push(`external: ${r.url()}`);
  });
  const res = await page.goto('/');
  expect(await res!.text()).toContain("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'");
  await expect(page.getByTestId('heatmap')).toBeVisible();
  await expect(page.getByTestId('trend-chart').locator('path.recharts-curve')).toBeVisible();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Matters', exact: true }).click();
  await expect(page.getByTestId('matters-table')).toBeVisible();
  expect(problems).toEqual([]);
});
