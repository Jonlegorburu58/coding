import { useFilterOptions } from '../api/hooks';
import { useGlobalFilters, type FilterKey } from '../state/filters';

/** Shared portfolio filter row. State lives in the URL query string. */
export function FilterBar({ hide = [] }: { hide?: FilterKey[] }) {
  const { filters, setFilter, clearFilters, activeCount } = useGlobalFilters();
  const { data } = useFilterOptions();
  const show = (k: FilterKey) => !hide.includes(k);
  return (
    <form className="filterbar no-print" aria-label="Filters" onSubmit={(e) => e.preventDefault()}>
      {show('practice_area') && (
        <div className="field">
          <label htmlFor="f-pa">Practice area</label>
          <select id="f-pa" className="select" value={filters.practice_area ?? ''} onChange={(e) => setFilter('practice_area', e.target.value)}>
            <option value="">All</option>
            {data?.practice_areas.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      )}
      {show('partner_id') && (
        <div className="field">
          <label htmlFor="f-partner">Partner</label>
          <select id="f-partner" className="select" value={filters.partner_id ?? ''} onChange={(e) => setFilter('partner_id', e.target.value)}>
            <option value="">All</option>
            {data?.partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {show('fee_earner_id') && (
        <div className="field">
          <label htmlFor="f-fe">Fee earner</label>
          <select id="f-fe" className="select" value={filters.fee_earner_id ?? ''} onChange={(e) => setFilter('fee_earner_id', e.target.value)}>
            <option value="">All</option>
            {data?.fee_earners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
      )}
      {show('office') && (
        <div className="field">
          <label htmlFor="f-office">Office</label>
          <select id="f-office" className="select" value={filters.office ?? ''} onChange={(e) => setFilter('office', e.target.value)}>
            <option value="">All</option>
            {data?.offices.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      )}
      {show('status') && (
        <div className="field status">
          <label htmlFor="f-status">Matter status</label>
          <select id="f-status" className="select" value={filters.status ?? 'open'} onChange={(e) => setFilter('status', e.target.value === 'open' ? undefined : e.target.value)}>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="all">All</option>
          </select>
        </div>
      )}
      {show('opened_from') && (
        <div className="field date">
          <label htmlFor="f-from">Opened from</label>
          <input id="f-from" className="input" type="date" value={filters.opened_from ?? ''}
            min={data?.opened_range?.min ?? undefined} max={filters.opened_to ?? data?.opened_range?.max ?? undefined}
            onChange={(e) => setFilter('opened_from', e.target.value)} />
        </div>
      )}
      {show('opened_to') && (
        <div className="field date">
          <label htmlFor="f-to">Opened to</label>
          <input id="f-to" className="input" type="date" value={filters.opened_to ?? ''}
            min={filters.opened_from ?? data?.opened_range?.min ?? undefined} max={data?.opened_range?.max ?? undefined}
            onChange={(e) => setFilter('opened_to', e.target.value)} />
        </div>
      )}
      <div className="clear">
        <button type="button" className="btn ghost small" onClick={clearFilters} disabled={activeCount === 0}>
          Clear filters{activeCount ? ` (${activeCount})` : ''}
        </button>
      </div>
    </form>
  );
}
