import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeQueryClient } from '../queryClient';
import { setup } from '../test/user';
import { PortalShell } from './PortalApp';
import { startPortalApi } from './shim';
import { portalStore } from './store';

/** The portal journey in jsdom, with the network fetch replaced by a spy that must never be called. */
const networkFetch = vi.fn(async () => new Response('should not happen'));
const original = window.fetch;

beforeAll(() => {
  window.fetch = networkFetch as unknown as typeof fetch;
  startPortalApi();
});
afterAll(() => {
  portalStore.clear();
  window.fetch = original;
});

function renderPortal() {
  const qc = makeQueryClient();
  qc.setDefaultOptions({ queries: { ...qc.getDefaultOptions().queries, retry: false } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}><PortalShell /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('portal flow', () => {
  it('opens on Import, loads the sample, maps it and shows the dashboard without using the network', async () => {
    const { user } = setup();
    renderPortal();
    expect(await screen.findByRole('heading', { name: 'Import an iManage export', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('No file imported')).toBeInTheDocument();

    await user.click(screen.getByTestId('load-sample'));
    const docsMap = await screen.findByTestId('map-docs');
    expect(within(docsMap).getByLabelText('Created date')).toHaveValue('Create Date');
    await user.click(screen.getByTestId('to-types'));
    expect(await screen.findByTestId('type-mapping')).toBeInTheDocument();
    await user.click(screen.getByTestId('run-import'));

    expect(await screen.findByRole('heading', { name: 'Portfolio', level: 1 }, { timeout: 10000 })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('coverage')).toHaveTextContent(/Based on 150 matters \/ [\d,]+ documents from the fictional sample export\. Held only in this browser tab\./));
    expect(screen.getByText('Sample file (fictional)')).toBeInTheDocument();
    expect(await screen.findByTestId('single-snapshot')).toHaveTextContent('Trend needs more than one import');
    expect(screen.queryByRole('button', { name: /Export CSV/ })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Copy as CSV/ }).length).toBeGreaterThan(0);

    await user.click(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: 'Matters' }));
    const table = await screen.findByTestId('matters-table');
    await user.click(within(table).getAllByRole('link')[0]!);
    expect(await screen.findByTestId('control-results')).toBeInTheDocument();

    await user.click(screen.getByTestId('clear-data'));
    expect(await screen.findByRole('heading', { name: 'Import an iManage export', level: 1 })).toBeInTheDocument();
    expect(portalStore.get().dataset).toBeNull();

    // Anything that is not the in-page API is refused without touching the network.
    await expect(fetch('https://example.invalid/collect', { method: 'POST', body: 'x' })).rejects.toThrow(/Network access is switched off/);
    await expect(fetch('/not-api/thing')).rejects.toThrow(TypeError);
    expect(networkFetch).not.toHaveBeenCalled();
  }, 60000);
});
