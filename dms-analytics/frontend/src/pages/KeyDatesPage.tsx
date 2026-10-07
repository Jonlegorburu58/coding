import { Link, useSearchParams } from 'react-router';
import { useKeyDates } from '../api/hooks';
import { RiskBadge } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { PageHead } from '../components/Layout';
import { EmptyResults, ErrorState, Loading } from '../components/States';
import { toCsv } from '../lib/csv';
import { fmtDate } from '../lib/format';

const WINDOWS = [30, 60, 90] as const;
type Win = (typeof WINDOWS)[number];

export function KeyDatesPage() {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get('within') ?? 30);
  const within: Win = (WINDOWS as readonly number[]).includes(raw) ? (raw as Win) : 30;
  const kd = useKeyDates(within);

  return (
    <>
      <PageHead title="Key dates" lead="Matters whose recorded key date falls soon. Dates come from the key-date field in iManage; matters without one are not listed." />
      <section className="card">
        <div className="card-head" style={{ alignItems: 'center' }}>
          <div className="titles">
            <h2>Next {within} days</h2>
            <div className="sub">Open matters with a key date between today and {within} days from now.</div>
          </div>
          <div className="card-actions">
            <div className="segmented" role="group" aria-label="Time window">
              {WINDOWS.map((w) => (
                <button key={w} type="button" aria-pressed={within === w} onClick={() => setParams(w === 30 ? {} : { within: String(w) }, { replace: true })}>
                  {w} days
                </button>
              ))}
            </div>
            <ExportButton filename={`key-dates-${within}d`} disabled={!kd.data?.length} build={() => toCsv(
              ['key_date', 'days_until', 'matter_code', 'matter_name', 'client_name', 'practice_area', 'partner', 'fee_earner', 'risk_score'],
              (kd.data ?? []).map((k) => [k.key_date, k.days_until, k.matter.matter_code, k.matter.matter_name, k.matter.client_name, k.matter.practice_area,
                k.matter.partner?.name, k.matter.fee_earner?.name, k.matter.risk_score]),
            )} />
          </div>
        </div>
        {kd.isPending ? <Loading label="Loading key dates…" /> : kd.isError ? <ErrorState error={kd.error} onRetry={() => void kd.refetch()} /> :
          kd.data.length === 0 ? <EmptyResults title={`No key dates in the next ${within} days`}>Try a longer window.</EmptyResults> : (
            <div className={`table-wrap ${kd.isPlaceholderData ? 'refetching' : ''}`}>
              <table className="data" data-testid="key-dates-table">
                <thead><tr><th>Key date</th><th className="num">Days away</th><th>Matter</th><th>Practice area</th><th>Partner</th><th>Fee earner</th><th>Risk</th></tr></thead>
                <tbody>
                  {kd.data.map((k) => (
                    <tr key={k.matter.id}>
                      <td className="nowrap" style={{ fontWeight: 600 }}>{fmtDate(k.key_date)}</td>
                      <td className="num">{k.days_until === 0 ? 'Today' : k.days_until}</td>
                      <td style={{ minWidth: 220 }}>
                        <Link className="cell-title" to={`/matters/${encodeURIComponent(k.matter.id)}`}>{k.matter.matter_code} · {k.matter.matter_name}</Link>
                        <div className="cell-sub">{k.matter.client_name}</div>
                      </td>
                      <td>{k.matter.practice_area ?? '—'}</td>
                      <td className="nowrap">{k.matter.partner?.name ?? '—'}</td>
                      <td className="nowrap">{k.matter.fee_earner?.name ?? '—'}</td>
                      <td><RiskBadge score={k.matter.risk_score} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        {kd.data?.length ? <div className="card-foot">{kd.data.length} matters</div> : null}
      </section>
    </>
  );
}
