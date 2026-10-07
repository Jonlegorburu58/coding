import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { fail, hang, renderApp } from './render';
import { resetMockState } from '../mocks/handlers';

const NO_DATA = 'No data yet. Run your first sync.';
const ERR = 'The analytics database could not be read. Try restarting the app.';

describe('Portfolio', () => {
  it('shows loading', async () => {
    hang('/api/portfolio/summary');
    renderApp('/');
    expect(await screen.findByText('Loading portfolio…')).toBeInTheDocument();
  });
  it('shows first-run guidance when there is no data', async () => {
    resetMockState('empty');
    renderApp('/');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Sync & settings' })).toHaveAttribute('href', '/settings');
  });
  it('shows the API error message', async () => {
    fail('/api/portfolio/summary');
    renderApp('/');
    expect(await screen.findByText(ERR)).toBeInTheDocument();
  });
  it('shows KPIs, control bars, heatmap, trend, coverage and mode badge', async () => {
    renderApp('/');
    expect(await screen.findByTestId('kpi-readiness')).toHaveTextContent('%');
    expect(screen.getByTestId('kpi-high-risk')).toHaveTextContent('High-risk matters');
    expect(screen.getByTestId('kpi-key-dates')).toHaveTextContent('Key dates, next 30 days');
    expect(await screen.findByTestId('heatmap')).toBeInTheDocument();
    expect(within(screen.getByTestId('control-bars')).getAllByRole('link')).toHaveLength(11);
    expect(await screen.findByTestId('coverage')).toHaveTextContent('Based on 412 workspaces');
    expect(screen.getByText('Demo data')).toBeInTheDocument();
    expect(screen.getByTestId('last-synced')).toHaveTextContent('Last synced');
  });
  it('control bars link to that control’s exceptions, keeping filters', async () => {
    renderApp('/?office=Dublin');
    const bars = await screen.findByTestId('control-bars');
    const link = within(bars).getByRole('link', { name: /^EL1 / });
    expect(link.getAttribute('href')).toBe('/exceptions?office=Dublin&control_id=EL1');
  });
  it('offers a table view of each chart', async () => {
    const { user } = await import('./user').then((m) => m.setup());
    renderApp('/');
    await screen.findByTestId('heatmap');
    const card = screen.getByTestId('card-controls');
    await user.click(within(card).getByRole('button', { name: 'View as table' }));
    expect(within(card).getByRole('table')).toHaveTextContent('Compliance');
  });
  it('shows a no-results state when filters match nothing', async () => {
    renderApp('/?practice_area=Nonexistent');
    expect(await screen.findByText('No matters match these filters')).toBeInTheDocument();
  });
});

describe('Controls', () => {
  it('shows loading', async () => {
    hang('/api/controls');
    renderApp('/controls');
    expect(await screen.findByRole('status')).toHaveTextContent('Loading');
  });
  it('shows first-run guidance', async () => {
    resetMockState('empty');
    renderApp('/controls/EL1');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
  });
  it('shows an error', async () => {
    fail('/api/controls');
    renderApp('/controls');
    expect(await screen.findByText(ERR)).toBeInTheDocument();
  });
  it('lists controls', async () => {
    renderApp('/controls');
    expect(await screen.findByRole('link', { name: /AML1\s+CDD before work/ })).toBeInTheDocument();
  });
  it('shows a control page', async () => {
    renderApp('/controls/EL1');
    expect(await screen.findByRole('heading', { level: 1, name: /Engagement letter \/ s\.150 notice/ })).toBeInTheDocument();
    expect(screen.getByText(/shows whether evidence is on file, not whether the step happened/)).toBeInTheDocument();
    expect(await screen.findByTestId('control-rate')).toHaveTextContent('%');
    expect(await screen.findByTestId('rate-bars')).toBeInTheDocument();
    expect(await screen.findByTestId('trend-chart')).toBeInTheDocument();
  });
});

describe('Exceptions', () => {
  it('shows loading', async () => {
    hang('/api/exceptions');
    renderApp('/exceptions');
    expect(await screen.findByText('Loading exceptions…')).toBeInTheDocument();
  });
  it('shows first-run guidance', async () => {
    resetMockState('empty');
    renderApp('/exceptions');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
  });
  it('shows an error', async () => {
    fail('/api/exceptions');
    renderApp('/exceptions');
    expect(await screen.findByText(ERR)).toBeInTheDocument();
  });
  it('shows a filtered table with explanations and an export button', async () => {
    renderApp('/exceptions?control_id=CF1&ex_status=missing');
    const table = await screen.findByTestId('exceptions-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => {
      expect(r).toHaveTextContent('CF1');
      expect(r).toHaveTextContent('Missing');
    });
    expect(table).toHaveTextContent('No conflict clearance found on file.');
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
  });
  it('shows an empty result', async () => {
    renderApp('/exceptions?practice_area=Nonexistent');
    expect(await screen.findByText('No exceptions match these filters')).toBeInTheDocument();
  });
});

describe('Matters', () => {
  it('shows loading', async () => {
    hang('/api/matters');
    renderApp('/matters');
    expect(await screen.findByText('Loading matters…')).toBeInTheDocument();
  });
  it('shows first-run guidance', async () => {
    resetMockState('empty');
    renderApp('/matters');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
  });
  it('shows an error', async () => {
    fail('/api/matters');
    renderApp('/matters');
    expect(await screen.findByText(ERR)).toBeInTheDocument();
  });
  it('lists matters sorted by risk by default, with risk badges', async () => {
    renderApp('/matters');
    const table = await screen.findByTestId('matters-table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(50);
    const scores = rows.map((r) => Number(r.querySelector('.risk span:nth-child(2)')!.textContent));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(screen.getByText(/Showing 1–50 of/)).toBeInTheDocument();
  });
  it('applies heatmap-style filters from the URL', async () => {
    renderApp('/matters?practice_area=Litigation&failing_control=EL1');
    const table = await screen.findByTestId('matters-table');
    within(table).getAllByRole('row').slice(1).forEach((r) => {
      expect(r).toHaveTextContent('Litigation');
      expect(r).toHaveTextContent('EL1');
    });
  });
  it('shows an empty result for a search that matches nothing', async () => {
    renderApp('/matters?q=zzzz-no-such-matter');
    expect(await screen.findByText('No matters match these filters')).toBeInTheDocument();
  });
});

describe('Matter detail', () => {
  it('shows loading', async () => {
    hang('/api/matters/:id');
    renderApp('/matters/MOCK!ws-0001');
    expect(await screen.findByText('Loading matter…')).toBeInTheDocument();
  });
  it('shows first-run guidance', async () => {
    resetMockState('empty');
    renderApp('/matters/MOCK!ws-0001');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
  });
  it('shows not found in plain English', async () => {
    renderApp('/matters/MOCK!nope');
    expect(await screen.findByText('Matter not found')).toBeInTheDocument();
    expect(screen.getByText(/It may no longer be visible to you/)).toBeInTheDocument();
  });
  it('shows an error', async () => {
    fail('/api/matters/:id');
    renderApp('/matters/MOCK!ws-0001');
    expect(await screen.findByText(ERR)).toBeInTheDocument();
  });
  it('shows profile, control results with evidence, timeline and document types', async () => {
    renderApp('/matters/MOCK!ws-0001');
    const results = await screen.findByTestId('control-results');
    expect(within(results).getAllByRole('row')).toHaveLength(12);
    expect(screen.getByTestId('timeline')).toHaveTextContent('Workspace created');
    expect(screen.getByText('Documents by type')).toBeInTheDocument();
    expect(screen.getByText('Profile')).toBeInTheDocument();
  });
});

describe('Key dates', () => {
  it('shows loading', async () => {
    hang('/api/key-dates');
    renderApp('/key-dates');
    expect(await screen.findByText('Loading key dates…')).toBeInTheDocument();
  });
  it('shows first-run guidance', async () => {
    resetMockState('empty');
    renderApp('/key-dates');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
  });
  it('shows an error', async () => {
    fail('/api/key-dates');
    renderApp('/key-dates');
    expect(await screen.findByText(ERR)).toBeInTheDocument();
  });
  it('lists key dates within the chosen window, soonest first', async () => {
    renderApp('/key-dates?within=90');
    const table = await screen.findByTestId('key-dates-table');
    const days = within(table).getAllByRole('row').slice(1).map((r) => r.querySelectorAll('td')[1]!.textContent!)
      .map((t) => (t === 'Today' ? 0 : Number(t)));
    expect(days.length).toBeGreaterThan(0);
    expect(Math.max(...days)).toBeLessThanOrEqual(90);
    expect([...days].sort((a, b) => a - b)).toEqual(days);
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
  });
  it('shows an empty window', async () => {
    const { server } = await import('./server');
    const { http, HttpResponse } = await import('msw');
    server.use(http.get('/api/key-dates', () => HttpResponse.json([])));
    renderApp('/key-dates');
    expect(await screen.findByText('No key dates in the next 30 days')).toBeInTheDocument();
  });
});

describe('Lexcel sampling', () => {
  it('shows first-run guidance', async () => {
    resetMockState('empty');
    renderApp('/lexcel');
    expect(await screen.findByText(NO_DATA)).toBeInTheDocument();
  });
  it('starts with an empty state, then shows a reproducible sample with the seed', async () => {
    const { user } = await import('./user').then((m) => m.setup());
    renderApp('/lexcel');
    expect(await screen.findByText('No sample yet')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Matters per fee earner')).toHaveValue(2));
    await user.type(screen.getByLabelText('Seed (optional)'), '777');
    await user.click(screen.getByRole('button', { name: 'Generate sample' }));
    expect(await screen.findByTestId('seed')).toHaveTextContent('777');
    const table = screen.getByTestId('lexcel-table');
    expect(table).toHaveTextContent('Fee Earner One');
    const first = table.textContent;
    await user.click(screen.getByRole('button', { name: 'Generate sample' }));
    await waitFor(() => expect(screen.getByTestId('lexcel-table').textContent).toBe(first));
  });
  it('shows loading and errors', async () => {
    const { server } = await import('./server');
    const { http, HttpResponse, delay } = await import('msw');
    const { user } = await import('./user').then((m) => m.setup());
    server.use(http.get('/api/lexcel/sample', async () => { await delay(200); return HttpResponse.json({ code: 'x', message: 'Sampling failed. Please try again.' }, { status: 500 }); }));
    renderApp('/lexcel');
    await user.click(await screen.findByRole('button', { name: 'Generate sample' }));
    expect(await screen.findByText('Drawing sample…')).toBeInTheDocument();
    expect(await screen.findByText('Sampling failed. Please try again.')).toBeInTheDocument();
  });
  it('rejects a non-numeric seed', async () => {
    const { user } = await import('./user').then((m) => m.setup());
    renderApp('/lexcel');
    await user.type(await screen.findByLabelText('Seed (optional)'), 'abc');
    await user.click(screen.getByRole('button', { name: 'Generate sample' }));
    expect(await screen.findByText(/The seed must be a whole number/)).toBeInTheDocument();
  });
});

describe('Session expired', () => {
  it('shows the expired-session screen on 401', async () => {
    resetMockState('expired');
    renderApp('/');
    expect(await screen.findByText('Session expired. Close this window and reopen the app.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Sections' })).not.toBeInTheDocument();
  });
});
