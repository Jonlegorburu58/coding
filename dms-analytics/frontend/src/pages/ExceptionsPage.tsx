import { Link, useSearchParams } from 'react-router';
import { useControls, useExceptions } from '../api/hooks';
import type { ExceptionItem, ExceptionSort } from '../api/types';
import { StatusPill } from '../components/Badges';
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
const SORTS: { value: ExceptionSort; label: string }[] = [
  { value: 'severity_desc', label: 'Severity (highest first)' },
  { value: 'days_late_desc', label: 'Days late (most first)' },
  { value: 'opened_desc', label: 'Matter opened (newest first)' },
];

export function ExceptionsPage() {
  const { filters, params, setFilter } = useGlobalFilters();
  const [, setParams] = useSearchParams();
  const controls = useControls();
  const controlId = params.get('control_id') ?? undefined;
  const exStatus = params.get('ex_status') ?? undefined;
  const sort = (params.get('sort') as ExceptionSort | null) ?? 'severity_desc';
  const page = Number(params.get('page') ?? 1) || 1;
  // The exceptions endpoint does not accept matter status or opened range (contract gap G1).
  const apiFilters = { practice_area: filters.practice_area, partner_id: filters.partner_id, fee_earner_id: filters.fee_earner_id, office: filters.office };
  const query = { ...apiFilters, control_id: controlId, status: exStatus, sort, page, page_size: PAGE_SIZE };
  const ex = useExceptions(query);
  const name = (id: string) => controls.data?.find((c) => c.id === id)?.name ?? id;

  const setPage = (p: number) => setParams((prev) => { const n = new URLSearchParams(prev); n.set('page', String(p)); return n; });

  async function buildCsv() {
    const all = await fetchAll<ExceptionItem>('/api/exceptions', { ...query, page: undefined, page_size: undefined });
    return toCsv(
      ['control_id', 'control', 'status', 'severity', 'days_late', 'due', 'matter_code', 'matter_name', 'client_name', 'practice_area', 'partner', 'fee_earner', 'office', 'explanation'],
      all.map((e) => [e.control_id, name(e.control_id), e.status, e.severity, e.days_late, e.due_at?.slice(0, 10), e.matter.matter_code, e.matter.matter_name,
        e.matter.client_name, e.matter.practice_area, e.matter.partner?.name, e.matter.fee_earner?.name, e.matter.office, e.explanation]),
    );
  }

  return (
    <>
      <PageHead title="Exceptions" lead="Every late, missing or stale control result, with the reason in plain English." />
      <FilterBar hide={['status', 'opened_from', 'opened_to']} />
      <section className="card">
        <div className="card-head" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 12, flex: 1 }}>
            <div className="field" style={{ width: 280 }}>
              <label htmlFor="ex-control">Control</label>
              <select id="ex-control" className="select" value={controlId ?? ''} onChange={(e) => setFilter('control_id', e.target.value)}>
                <option value="">All controls</option>
                {controls.data?.map((c) => <option key={c.id} value={c.id}>{c.id} — {c.name}</option>)}
              </select>
            </div>
            <div className="field" style={{ width: 220 }}>
              <label htmlFor="ex-status">Result</label>
              <select id="ex-status" className="select" value={exStatus ?? ''} onChange={(e) => setFilter('ex_status', e.target.value)}>
                <option value="">Late, missing or stale</option>
                <option value="late">Late</option><option value="missing">Missing</option><option value="stale">Stale</option>
              </select>
            </div>
            <div className="field" style={{ width: 230 }}>
              <label htmlFor="ex-sort">Sort by</label>
              <select id="ex-sort" className="select" value={sort} onChange={(e) => setFilter('sort', e.target.value === 'severity_desc' ? undefined : e.target.value)}>
                {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          <div className="card-actions">
            <ExportButton filename="exceptions" build={buildCsv} disabled={!ex.data?.total} />
          </div>
        </div>
        {ex.isPending ? <Loading label="Loading exceptions…" /> : ex.isError ? <ErrorState error={ex.error} onRetry={() => void ex.refetch()} /> :
          ex.data.total === 0 ? <EmptyResults title="No exceptions match these filters">That is good news, or the filters are too narrow.</EmptyResults> : (
            <div className={ex.isPlaceholderData ? 'refetching' : ''}>
              <div className="table-wrap">
                <table className="data" data-testid="exceptions-table">
                  <caption className="visually-hidden">Exceptions, sorted by {SORTS.find((s) => s.value === sort)?.label}</caption>
                  <thead>
                    <tr>
                      <th>Control</th><th>Result</th><th>Matter</th><th>Practice area</th><th>Partner / fee earner</th>
                      <th className="num" aria-sort={sort === 'days_late_desc' ? 'descending' : undefined}>Days late</th>
                      <th>Explanation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ex.data.items.map((e) => (
                      <tr key={`${e.matter.id}-${e.control_id}`}>
                        <td style={{ minWidth: 150 }}>
                          <div className="cell-title"><span className="tag">{e.control_id}</span> <span className="small muted">Sev. {e.severity}</span></div>
                          <div className="cell-sub">{name(e.control_id)}</div>
                        </td>
                        <td><StatusPill status={e.status} /></td>
                        <td style={{ minWidth: 180 }}>
                          <Link to={`/matters/${encodeURIComponent(e.matter.id)}`} className="cell-title">{e.matter.matter_code}</Link>
                          <div className="cell-sub">{e.matter.matter_name} · {e.matter.client_name}</div>
                        </td>
                        <td>{e.matter.practice_area ?? '—'}</td>
                        <td className="nowrap">{e.matter.partner?.name ?? '—'}<div className="cell-sub">{e.matter.fee_earner?.name ?? '—'}</div></td>
                        <td className="num">{e.days_late ?? '—'}</td>
                        <td className="secondary" style={{ minWidth: 220 }}>
                          {e.explanation}
                          {e.due_at ? <div className="cell-sub">Due {fmtDate(e.due_at)}</div> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager page={ex.data.page} pageSize={ex.data.page_size} total={ex.data.total} onPage={setPage} noun="exceptions" />
            </div>
          )}
      </section>
      <p className="small muted">{ex.data ? `${fmtInt(ex.data.total)} exceptions. ` : ''}Exceptions cover open and closed matters; the matter status and opened-date filters do not apply here.</p>
    </>
  );
}
