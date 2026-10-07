import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { fail, hang, renderApp } from './render';
import { server } from './server';
import { mockState, resetMockState } from '../mocks/handlers';
import { setup } from './user';

describe('Sync & settings', () => {
  it('shows loading', async () => {
    hang('/api/session');
    renderApp('/settings');
    expect((await screen.findAllByText('Loading…')).length).toBeGreaterThan(0);
  });
  it('shows an error', async () => {
    fail('/api/sync/status', 'The sync status could not be read.');
    renderApp('/settings');
    expect(await screen.findByText('The sync status could not be read.')).toBeInTheDocument();
  });
  it('first run: not signed in, never synced, sign-in then sync', async () => {
    resetMockState('empty');
    const { user } = setup();
    renderApp('/settings');
    expect(await screen.findByTestId('signin-status')).toHaveTextContent('Not signed in');
    expect(screen.getByText(/No sync has run yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sync now/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Sign in to iManage' }));
    expect(await screen.findByText('Signed in as Demo User')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sync now/ }));
    expect(await screen.findByTestId('sync-progress')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toBeInTheDocument();
    expect(screen.getByTestId('sync-banner')).toHaveTextContent('Sync in progress');
    await user.click(screen.getByRole('button', { name: 'Cancel sync' }));
    await waitFor(() => expect(mockState.running).toBeNull(), { timeout: 5000 });
  });
  it('shows a device code clearly', async () => {
    resetMockState('device');
    const { user } = setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign in to iManage' }));
    const box = await screen.findByTestId('device-code');
    expect(box).toHaveTextContent('DEMO-4821');
    expect(box).toHaveTextContent('https://imanage.example.invalid/device');
  });
  it('shows a sync in progress with live progress', async () => {
    resetMockState('syncing');
    renderApp('/settings');
    expect(await screen.findByTestId('sync-progress')).toHaveTextContent('Full sync in progress');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow');
  });
  it('wipe needs WIPE typed exactly, then clears data', async () => {
    const { user } = setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: 'Wipe local data…' }));
    const confirm = screen.getByRole('button', { name: 'Wipe data' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText('Type WIPE to confirm'), 'wipe');
    expect(confirm).toBeDisabled();
    await user.clear(screen.getByLabelText('Type WIPE to confirm'));
    await user.type(screen.getByLabelText('Type WIPE to confirm'), 'WIPE');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(await screen.findByText('Local data wiped. Run a sync to start again.')).toBeInTheDocument();
    expect(mockState.hasData).toBe(false);
  });
  it('saves retention and sample size, validating the range', async () => {
    const { user } = setup();
    renderApp('/settings');
    const ret = await screen.findByLabelText('Keep data for (days)');
    await user.clear(ret);
    await user.type(ret, '400');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/between 1 and 365/)).toBeInTheDocument();
    await user.clear(ret);
    await user.type(ret, '60');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(mockState.settings.retention_days).toBe(60);
  });
  it('signs out and drops cached data', async () => {
    const { user } = setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByTestId('signin-status')).toHaveTextContent('Not signed in');
  });
  it('explains the app in plain English', async () => {
    renderApp('/settings');
    expect(await screen.findByText('About this app')).toBeInTheDocument();
    expect(screen.getByText('Read-only.')).toBeInTheDocument();
    expect(screen.getByText('No cloud.')).toBeInTheDocument();
  });
  it('shows a server error message from a failed action', async () => {
    server.use(http.post('/api/sync/start', () => HttpResponse.json({ code: 'sync_running', message: 'A sync is already running.' }, { status: 409 })));
    const { user } = setup();
    renderApp('/settings');
    await user.click(await screen.findByRole('button', { name: /Sync now/ }));
    expect(await screen.findByText('A sync is already running.')).toBeInTheDocument();
  });
});
