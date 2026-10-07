import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useControls, useMatters } from '../api/hooks';
import type { MatterSort, MatterSummary } from '../api/types';
import { RiskBadge } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { FilterBar } from '../components/FilterBar';
import { PageHead } from '../components/Layout';
import { Pager } from '../components/Pager';
import { EmptyResults, ErrorState, Loading } from '../components/States';
import { toCsv } from '../lib/csv';
import { fetchAll } from '../lib/fetchAll';
import { fmtDate, fmtInt } from '../lib/format';
import { useGlobalFilters } from '../state/filters';

const PAGE_SIZE = 50;
const SORTS: { value: MatterSort; label: string }[] = [
  { value: 'risk_desc', label: 'Risk (highest first)' },
  { value: 'risk_asc', label: 'Risk (lowest first)' },
  { value: 'activity_desc', label: 'Last activity (newest)' },
  { value: 'activity_asc', label: 'Last activity (oldest)' },
  { value: 'opened_desc', label: 'Opened (newest)' },
  { value: 'opened_asc', label: 'Opened (oldest)' },
  { value: 'matter_code', label: 'Matter code' },
];

export function MattersPage() {
  const { filters, params, setFilter } = useGlobalFilters();
  const [, setParams] = useSearchParams();
  const navigate = useNavigate();
  const controls = useControls();
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const failing = params.get('failing_control') ?? undefined;
  const minRisk = params.get('min_risk') ?? undefined;
  const sort = (params.get('sort') as MatterSort | null) ?? 'risk_desc';
  const page = Number(params.get('page') ?? 1) || 1;
  const query = { ...filters, q: q || undefined, failing_control: failing, min_risk: minRisk, sort, page, page_size: PAGE_SIZE };
  const matters = useMatters(query);

  // Debounced search box -> URL.
  useEffect(() => {
    if (text === q) return;
    const t = setTimeout(() => setFilter('q', text.trim() || undefined), 300);
    return () => clearTimeout(t);
  }, [text, q, setFilter]);

  const setPage = (p: number) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('page', String(p)); return n; });
  const open = (m: MatterSummary) => navigate(`/matters/${encodeURIComponent(m.id)}`);

  async function buildCsv() {
    const all = await fetchAll<MatterSummary>('/api/matters', { ...query, page: undefined, page_size: undefined });
    return toCsv(
      ['matter_code', 'matter_name', 'client_code', 'client_name', 'practice_area', 'partner', 'fee_earner', 'office', 'status', 'opened', 'last_activity', 'documents', 'risk_score', 'failing_controls', 'key_date'],
      all.map((m) => [m.matter_code, m.matter_name, m.client_code, m.client_name, m.practice_area, m.partner?.name, m.fee_earner?.name, m.office, m.status,
        m.opened_at.slice(0, 10), m.last_activity_at?.slice(0, 10), m.doc_count, m.risk_score, m.failing_controls.join(' '), m.key_date]),
    );
  }

  return (
    <>
      <PageHead title="Matters" lead="Matters visible to you, highest risk first. Select a matter to see its control results and filing history." />
      <FilterBar />
      <section className="card">
        <div className="card-head" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 12, flex: 1 }}>
            <div className="field" style={{ width: 280 }}>
              <label htmlFor="m-q">Search</label>
              <input id="m-q" className="input" type="search" placeholder="Client or matter code or name" value={text} onChange={(e) => setText(e.target.value)} />
            </div>
            <div className="field" style={{ width: 250 }}>
              <label htmlFor="m-failing">Failing control</label>
              <select id="m-failing" className="select" value={failing ?? ''} onChange={(e) => setFilter('failing_control', e.target.value)}>
                <option value="">Any</option>
                {controls.data?.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ width: 140 }}>
              <label htmlFor="m-risk">Risk score</label>
              <select id="m-risk" className="select" value={minRisk ?? ''} onChange={(e) => setFilter('min_risk', e.target.value)}>
                <option value="">Any</option><option value="25">25 or more</option><option value="50">50 or more (high)</option>
              </select>
            </div>
            <div className="field" style={{ width: 200 }}>
              <label htmlFor="m-sort">Sort by</label>
              <select id="m-sort" className="select" value={sort} onChange={(e) => setFilter('sort', e.target.value === 'risk_desc' ? undefined : e.target.value)}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className="card-actions"><ExportButton filename="matters" build={buildCsv} disabled={!matters.data?.total} /></div>
        </div>
        {matters.isPending ? <Loading label="Loading matters…" /> : matters.isError ? <ErrorState error={matters.error} onRetry={() => void matters.refetch()} /> :
          matters.data.total === 0 ? <EmptyResults title="No matters match these filters">Try a different search or clear some filters.</EmptyResults> : (
            <div className={matters.isPlaceholderData ? 'refetching' : ''}>
              <div className="table-wrap">
                <table className="data" data-testid="matters-table">
                  <caption className="visually-hidden">Matters, sorted by {SORTS.find((s) => s.value === sort)?.label}</caption>
                  <thead>
                    <tr>
                      <th aria-sort={sort.startsWith('risk') ? (sort === 'risk_desc' ? 'descending' : 'ascending') : undefined}>Risk</th>
                      <th>Matter</th><th>Practice area</th><th>Partner / fee earner</th><th>Opened</th>
                      <th aria-sort={sort.startsWith('activity') ? (sort === 'activity_desc' ? 'descending' : 'ascending') : undefined}>Last activity</th>
                      <th className="num">Docs</th><th>Failing controls</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matters.data.items.map((m) => (
                      <tr key={m.id} className="clickable" onClick={() => open(m)}>
                        <td><RiskBadge score={m.risk_score} /></td>
                        <td style={{ minWidth: 220 }}>
                          <Link to={`/matters/${encodeURIComponent(m.id)}`} className="cell-title" onClick={(e) => e.stopPropagation()}>{m.matter_code} · {m.matter_name}</Link>
                          <div className="cell-sub">{m.client_name}{m.status === 'closed' ? ' · Closed' : ''}</div>
                        </td>
                        <td>{m.practice_area ?? '—'}</td>
                        <td className="nowrap">{m.partner?.name ?? '—'}<div className="cell-sub">{m.fee_earner?.name ?? '—'}</div></td>
                        <td className="nowrap">{fmtDate(m.opened_at)}</td>
                        <td className="nowrap">{fmtDate(m.last_activity_at)}</td>
                        <td className="num">{fmtInt(m.doc_count)}</td>
                        <td>{m.failing_controls.length ? m.failing_controls.map((c) => <span key={c} className="tag">{c}</span>) : <span className="muted">None</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={matters.data.page} pageSize={matters.data.page_size} total={matters.data.total} onPage={setPage} noun="matters" />
            </div>
          )}
      </section>
    </>
  );
}
