import { fmtInt } from '../lib/format';

export function Pager({ page, pageSize, total, onPage, noun = 'rows' }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; noun?: string;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pagination">
      <span className="num">Showing {fmtInt(from)}–{fmtInt(to)} of {fmtInt(total)} {noun}</span>
      <span className="spacer" />
      <button type="button" className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
      <span className="num">Page {page} of {pages}</span>
      <button type="button" className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
    </nav>
  );
}
