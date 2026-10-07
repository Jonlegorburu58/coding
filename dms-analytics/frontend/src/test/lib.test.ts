import { afterEach, describe, expect, it, vi } from 'vitest';
import { csvEscape, toCsv } from '../lib/csv';
import { heatBin } from '../charts/heat';
import { heatmapCellLink } from '../lib/links';
import { apiGet, SessionExpiredError } from '../api/client';
import { riskScore } from '../mocks/data';

describe('CSV', () => {
  it('quotes and neutralises spreadsheet formulas in untrusted text', () => {
    expect(csvEscape('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvEscape('+1')).toBe("'+1");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvEscape(-5)).toBe('-5');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x\ny']])).toBe('a,b\r\n1,"x\ny"\r\n');
  });
});

describe('heatmap', () => {
  it('bins compliance rates, darkest for lowest', () => {
    expect(heatBin(1)).toBe(0);
    expect(heatBin(0.92)).toBe(1);
    expect(heatBin(0.75)).toBe(4);
    expect(heatBin(0.1)).toBe(6);
  });
  it('builds matter-list links for each dimension', () => {
    const row = { key: 'p03', label: 'Partner Charlie', matters: 1, readiness: 1, cells: [] };
    expect(heatmapCellLink({ office: 'Cork' }, 'partner', row, 'EL1')).toBe('/matters?partner_id=p03&office=Cork&failing_control=EL1');
    expect(heatmapCellLink({}, 'opened_month', { ...row, key: '2024-02' }, 'CF1'))
      .toBe('/matters?opened_from=2024-02-01&opened_to=2024-02-29&failing_control=CF1');
  });
});

describe('API client', () => {
  afterEach(() => vi.restoreAllMocks());
  it('sends the app header with same-origin credentials, and no token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"status":"ok"}', { status: 200 }));
    await apiGet('/api/health', { a: 1, b: undefined });
    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/health\?a=1$/);
    expect(new URL(String(url)).origin).toBe(window.location.origin);
    expect(init!.credentials).toBe('same-origin');
    expect((init!.headers as Record<string, string>)['X-DMS-Analytics']).toBe('1');
    expect(JSON.stringify(init!.headers)).not.toMatch(/authorization|token/i);
  });
  it('maps 401 to a session-expired error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    await expect(apiGet('/api/session')).rejects.toBeInstanceOf(SessionExpiredError);
  });
  it('refuses non-API paths', async () => {
    await expect(apiGet('https://example.invalid/api/x')).rejects.toThrow();
  });
});

describe('mock risk score', () => {
  it('follows the architecture formula', () => {
    const r = (control_id: string, status: 'pass' | 'missing' | 'pending') => ({ control_id, status, basis: 'imanage_filing' as const });
    // EL1 sev 3 missing, FO1 sev 2 pass, AN1 pending excluded -> 3/5
    expect(riskScore([r('EL1', 'missing'), r('FO1', 'pass'), r('AN1', 'pending')])).toBe(60);
    expect(riskScore([r('AN1', 'pending')])).toBeNull();
  });
});
