import { useState } from 'react';
import { Link } from 'react-router';
import { useFilterOptions, useLexcelSample, useSettings } from '../api/hooks';
import { RiskBadge } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Layout';
import { EmptyResults, ErrorState, Loading } from '../components/States';
import { toCsv } from '../lib/csv';
import { fmtDate, fmtDateTime } from '../lib/format';
import { useVariant } from '../lib/variant';

export function LexcelPage() {
  const settings = useSettings();
  const options = useFilterOptions();
  const sample = useLexcelSample();
  const { canPrint } = useVariant();
  const [per, setPer] = useState<number | null>(null);
  const [seed, setSeed] = useState('');
  const [pa, setPa] = useState('');
  const [office, setOffice] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const perValue = per ?? settings.data?.sample_per_fee_earner ?? null;

  function generate(e: React.FormEvent) {
    e.preventDefault();
    const n = perValue ?? 2;
    if (!Number.isInteger(n) || n < 1 || n > 10) return setFormError('Choose between 1 and 10 matters per fee earner.');
    if (seed && !/^\d{1,9}$/.test(seed.trim())) return setFormError('The seed must be a whole number (digits only), or left blank.');
    setFormError(null);
    sample.mutate({ per_fee_earner: n, seed: seed ? Number(seed.trim()) : undefined, practice_area: pa || undefined, office: office || undefined });
  }

  const data = sample.data;
  const total = data?.items.reduce((a, g) => a + g.matters.length, 0) ?? 0;

  return (
    <>
      <PageHead title="Lexcel file-review sample"
        lead="Pick matters for file review, weighted towards higher-risk matters. Keep the seed: entering the same seed and settings again reproduces exactly the same sample for the audit trail." />
      <form className="card no-print" onSubmit={generate} aria-label="Sample settings" noValidate>
        <div className="card-body" style={{ paddingTop: 16 }}>
          <div className="row" style={{ gap: 14, alignItems: 'flex-end' }}>
            <div className="field" style={{ width: 190 }}>
              <label htmlFor="lx-per">Matters per fee earner</label>
              <input id="lx-per" className="input" type="number" min={1} max={10} step={1} value={perValue ?? ''} onChange={(e) => setPer(e.target.value === '' ? null : Number(e.target.value))} />
            </div>
            <div className="field" style={{ width: 210 }}>
              <label htmlFor="lx-seed">Seed (optional)</label>
              <input id="lx-seed" className="input code" inputMode="numeric" placeholder="New random seed" value={seed} onChange={(e) => setSeed(e.target.value)} aria-describedby="lx-seed-help" />
            </div>
            <div className="field" style={{ width: 190 }}>
              <label htmlFor="lx-pa">Practice area</label>
              <select id="lx-pa" className="select" value={pa} onChange={(e) => setPa(e.target.value)}>
                <option value="">All</option>
                {options.data?.practice_areas.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field" style={{ width: 150 }}>
              <label htmlFor="lx-office">Office</label>
              <select id="lx-office" className="select" value={office} onChange={(e) => setOffice(e.target.value)}>
                <option value="">All</option>
                {options.data?.offices.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
            <button type="submit" className="btn primary" disabled={sample.isPending}>{sample.isPending ? 'Generating…' : 'Generate sample'}</button>
          </div>
          <p id="lx-seed-help" className="small muted" style={{ marginTop: 8 }}>Leave the seed blank to draw a new sample. To repeat an earlier sample, enter its seed.</p>
          {formError ? <p className="banner error small" role="alert" style={{ marginTop: 8 }}>{formError}</p> : null}
        </div>
      </form>

      {sample.isPending ? <div className="card"><Loading label="Drawing sample…" /></div> : null}
      {sample.isError ? <div className="card"><ErrorState error={sample.error} /></div> : null}
      {!data && !sample.isPending && !sample.isError ? (
        <div className="card"><EmptyResults title="No sample yet">Choose the settings above and select Generate sample.</EmptyResults></div>
      ) : null}
      {data ? (
        <>
          <div className="seed-box" data-testid="seed-box">
            <span><span className="small secondary" style={{ display: 'block' }}>Seed</span><span className="seed" data-testid="seed">{data.seed}</span></span>
            <span className="secondary small" style={{ flex: 1 }}>
              {data.per_fee_earner} per fee earner · {total} matters · generated {fmtDateTime(data.generated_at)}
              {pa ? ` · ${pa}` : ''}{office ? ` · ${office}` : ''}
              <br />Record this seed with the review. The same seed and settings always give the same sample.
            </span>
            <span className="row no-print">
              <button type="button" className="btn small" onClick={() => setSeed(String(data.seed))}>Reuse seed</button>
              {canPrint ? <button type="button" className="btn small" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button> : null}
              <ExportButton filename={`lexcel-sample-seed-${data.seed}`} build={() => toCsv(
                ['seed', 'per_fee_earner', 'generated_at', 'fee_earner', 'matter_code', 'matter_name', 'client_name', 'practice_area', 'partner', 'opened', 'risk_score', 'failing_controls'],
                data.items.flatMap((g) => g.matters.map((m) => [data.seed, data.per_fee_earner, data.generated_at, g.fee_earner.name, m.matter_code, m.matter_name,
                  m.client_name, m.practice_area, m.partner?.name, m.opened_at.slice(0, 10), m.risk_score, m.failing_controls.join(' ')])),
              )} />
            </span>
          </div>
          {data.items.length === 0 ? <div className="card"><EmptyResults title="No matters to sample">No fee earners have matters for these settings.</EmptyResults></div> : (
            <section className="card">
              <div className="print-only" style={{ padding: '0 0 8px' }}>
                <h2>Lexcel file-review sample — seed {data.seed}</h2>
              </div>
              <div className="table-wrap">
                <table className="data" data-testid="lexcel-table">
                  <caption className="visually-hidden">Sample grouped by fee earner</caption>
                  <thead><tr><th>Matter</th><th>Practice area</th><th>Partner</th><th>Opened</th><th>Risk</th><th>Failing controls</th><th className="print-only">Reviewed</th></tr></thead>
                  {data.items.map((g) => (
                    <tbody key={g.fee_earner.id}>
                      <tr className="group-row"><td colSpan={6}>{g.fee_earner.name} <span className="muted small">· {g.matters.length} matters</span></td></tr>
                      {g.matters.map((m) => (
                        <tr key={m.id}>
                          <td style={{ minWidth: 220 }}>
                            <Link className="cell-title" to={`/matters/${encodeURIComponent(m.id)}`}>{m.matter_code} · {m.matter_name}</Link>
                            <div className="cell-sub">{m.client_name}</div>
                          </td>
                          <td>{m.practice_area ?? '—'}</td>
                          <td className="nowrap">{m.partner?.name ?? '—'}</td>
                          <td className="nowrap">{fmtDate(m.opened_at)}</td>
                          <td><RiskBadge score={m.risk_score} /></td>
                          <td>{m.failing_controls.length ? m.failing_controls.map((c) => <span key={c} className="tag">{c}</span>) : <span className="muted">None</span>}</td>
                          <td className="print-only">☐</td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            </section>
          )}
        </>
      ) : null}
      {settings.isPending ? <span className="visually-hidden"><Loading /></span> : null}
    </>
  );
}
