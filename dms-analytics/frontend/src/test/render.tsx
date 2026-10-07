import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { http, HttpResponse, delay } from 'msw';
import { AppShell, Providers } from '../App';
import { makeQueryClient } from '../queryClient';
import { server } from './server';

export function renderApp(route = '/') {
  const client = makeQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  return render(
    <Providers client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AppShell />
      </MemoryRouter>
    </Providers>,
  );
}

/** Make one GET endpoint hang forever (loading state). */
export function hang(path: string) {
  server.use(http.get(path, async () => { await delay('infinite'); return HttpResponse.json({}); }));
}

/** Make one GET endpoint fail with a plain-English API error. */
export function fail(path: string, message = 'The analytics database could not be read. Try restarting the app.', status = 500) {
  server.use(http.get(path, () => HttpResponse.json({ code: 'internal', message }, { status })));
}
