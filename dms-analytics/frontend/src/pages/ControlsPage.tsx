import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useBreakdown, useControls, usePortfolioSummary, useTrend } from '../api/hooks';
import type { ControlDef, ControlTally, Dimension } from '../api/types';
import { ChartCard } from '../components/ChartCard';
import { FilterBar } from '../components/FilterBar';
import { PageHead } from '../components/Layout';
import { StatusPill } from '../components/Badges';
import { EmptyResults, ErrorState, Loading, SingleSnapshot } from '../components/States';
import { useVariant } from '../lib/variant';
import { RateBars } from '../charts/RateBars';
import { TrendChart, TrendTable } from '../charts/TrendChart';
import { ExportButton } from '../components/ExportButton';
import { Icon } from '../components/Icon';
import { toCsv } from '../lib/csv';
import { fmtInt, fmtRate, trendRangeLabel } from '../lib/format';
import { BASIS_TEXT, DIMENSIONS } from '../lib/status';
import { filterQuery, useGlobalFilters } from '../state/filters';

const CATEGORY: Record<ControlDef['category'], string> = {
  file_opening: 'File opening', conflicts: 'Conflicts', aml: 'Anti-money laundering', engagement: 'Engagement',
  attendance: 'Attendance notes', critical_dates: 'Critical dates', fees: 'Fees and costs', hygiene: 'File hygiene',
};
const SEVERITY = { 1: 'Low (1)', 2: 'Medium (2)', 3: 'High (3)' } as Record<number, string>;
const TALLY_KEYS = ['pass', 'late', 'missing', 'stale', 'pending', 'not_applicable', 'unknown'] as const;

export function ControlsPage() {
  const { controlId } = useParams();
  const controls = useControls();
  const { filters } = useGlobalFilters();
  const summary = usePortfolioSummary(filters);

  if (controls.isPending) return <><PageHead title="Controls" /><div className="card"><Loading /></div></>;
  if (controls.isError) return <><PageHead title="Controls" /><div className="card"><ErrorState error={controls.error} onRetry={() => void controls.refetch()} /></div></>;
  if (controls.data.length === 0) return <><PageHead title="Controls" /><div className="card"><EmptyResults title="No controls are configured">Ask the risk team to check controls.yaml.</EmptyResults></div></>;

  if (!controlId) return <ControlsIndex defs={controls.data} tallies={summary.data?.controls} />;
  const def = controls.data.find((c) => c.id === controlId);
  if (!def) return <><PageHead title="Controls" /><div className="card"><EmptyResults title="That control does not exist">
    <Link to="/controls">See all controls</Link></EmptyResults></div></>;
  return <ControlDetail def={def} defs={controls.data} tally={summary.data?.controls.find((t) => t.control_id === def.id)} summaryState={summary} />;
}

function ControlsIndex({ defs, tallies }: { defs: ControlDef[]; tallies: ControlTally[] | undefined }) {
  const { filters } = useGlobalFilters();
  return (
    <>
      <PageHead title="Controls" lead="Each control checks whether a piece of evidence is on file in iManage. Select a control for its definition, breakdown and trend." />
      <FilterBar />
      <section className="card">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Control</th><th>What it checks</th><th>Severity</th><th className="num">Compliance</th><th className="num">Exceptions</th></tr></thead>
            <tbody>
              {defs.map((d) => {
                const t = tallies?.find((x) => x.control_id === d.id);
                return (
                  <tr key={d.id}>
                    <td className="nowrap"><Link to={`/controls/${encodeURIComponent(d.id)}${filterQuery(filters)}`} className="cell-title">
                      <span className="tag">{d.id}</span> {d.name}</Link></td>
                    <td className="secondary">{d.description}</td>
                    <td className="nowrap">{SEVERITY[d.severity]}</td>
                    <td className="num">{t ? fmtRate(t.compliance_rate) : '…'}</td>
                    <td className="num">{t ? fmtInt(t.late + t.missing + t.stale) : '…'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ControlDetail({ def, defs, tally, summaryState }: {
  def: ControlDef; defs: ControlDef[]; tally: ControlTally | undefined; summaryState: ReturnType<typeof usePortfolioSummary>;
}) {
  const navigate = useNavigate();
  const { filters } = useGlobalFilters();
  const [dimension, setDimension] = useState<Dimension>('practice_area');
  const breakdown = useBreakdown(dimension, filters);
  const trend = useTrend(def.id);
  const variant = useVariant();
  const dim = DIMENSIONS.find((d) => d.value === dimension)!;
  const bars = (breakdown.data?.rows ?? []).map((r) => {
    const c = r.cells.find((x) => x.control_id === def.id);
    return { key: r.key, label: r.label, rate: c?.compliance_rate ?? null, passing: c?.passing ?? 0, applicable: c?.applicable ?? 0 };
  }).sort((a, b) => (a.rate ?? 2) - (b.rate ?? 2));

  return (
    <>
      <PageHead
        title={<><span className="tag" style={{ fontSize: 14, verticalAlign: 'middle' }}>{def.id}</span> {def.name}</>}
        lead={def.description}
        actions={
          <>
            <label className="visually-hidden" htmlFor="ctl-pick">Choose control</label>
            <select id="ctl-pick" className="select" value={def.id} onChange={(e) => navigate(`/controls/${encodeURIComponent(e.target.value)}${filterQuery(filters)}`)}>
              {defs.map((d) => <option key={d.id} value={d.id}>{d.id} — {d.name}</option>)}
            </select>
            <Link className="btn primary" to={`/exceptions${filterQuery(filters, { control_id: def.id })}`}>View exceptions</Link>
          </>
        }
      />
      <FilterBar />
      <div className="grid-2-even">
        <section className="card" aria-labelledby="def-h">
          <div className="card-head"><div className="titles"><h2 id="def-h">Definition</h2></div></div>
          <div className="card-body stack-v">
            <dl className="kv">
              <dt>Category</dt><dd>{CATEGORY[def.category]}</dd>
              <dt>Severity</dt><dd>{SEVERITY[def.severity]}</dd>
              <dt>Configured</dt><dd>{def.configured ? 'Yes' : 'No — the document mapping is missing, so every result is "unknown".'}</dd>
            </dl>
            <div className="banner warn" role="note">
              <Icon name="info" />
              <span><strong>Basis.</strong> {BASIS_TEXT}</span>
            </div>
          </div>
        </section>
        <section className="card" aria-labelledby="tally-h">
          <div className="card-head">
            <div className="titles"><h2 id="tally-h">Results</h2><div className="sub">Matters by result, for the filters above.</div></div>
          </div>
          <div className="card-body">
            {summaryState.isPending ? <Loading /> : summaryState.isError ? <ErrorState error={summaryState.error} /> : tally ? (
              <div className="stack-v">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                  <span className="kpi-value" data-testid="control-rate">{fmtRate(tally.compliance_rate, 1)}</span>
                  <span className="secondary">compliance rate · {fmtInt(tally.applicable)} applicable matters</span>
                </div>
                <table className="data" style={{ fontSize: 13 }}>
                  <tbody>
                    {TALLY_KEYS.map((k) => (
                      <tr key={k}><td style={{ paddingLeft: 0 }}><StatusPill status={k} /></td><td className="num">{fmtInt(tally[k])}</td>
                        <td style={{ width: '45%' }}>
                          {['late', 'missing', 'stale'].includes(k) && tally[k] > 0 ? (
                            <Link to={`/exceptions${filterQuery(filters, { control_id: def.id, ex_status: k })}`} className="small">View {tally[k]} {k}</Link>
                          ) : null}
                        </td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <EmptyResults title="No results for this control" />}
          </div>
        </section>
      </div>
      <div className="grid-2-even">
        <ChartCard
          testId="card-breakdown"
          title={`Compliance by ${dim.label.toLowerCase()}`}
          subtitle={`${def.id} compliance rate (%), lowest first. Select a bar to see failing matters.`}
          actions={
            <>
              <label htmlFor="bd-dim" className="small secondary">By</label>
              <select id="bd-dim" className="select" style={{ height: 28 }} value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
                {DIMENSIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
              </select>
              <ExportButton filename={`${def.id}-by-${dimension}`} disabled={!bars.length}
                build={() => toCsv([dim.label, 'compliance_rate', 'passing', 'applicable'], bars.map((b) => [b.label, b.rate, b.passing, b.applicable]))} />
            </>
          }
          chart={breakdown.isPending ? <Loading /> : breakdown.isError ? <ErrorState error={breakdown.error} /> :
            bars.length ? <RateBars data={bars} onSelect={(b) => navigate(`/matters${filterQuery({ ...filters, [dim.param]: b.key }, { failing_control: def.id })}`)} /> :
              <EmptyResults title="Nothing to show for these filters" />}
          table={
            <table className="data">
              <thead><tr><th>{dim.label}</th><th className="num">Compliance</th><th className="num">Passing</th><th className="num">Applicable</th></tr></thead>
              <tbody>{bars.map((b) => <tr key={b.key}><td>{b.label}</td><td className="num">{fmtRate(b.rate, 1)}</td><td className="num">{fmtInt(b.passing)}</td><td className="num">{fmtInt(b.applicable)}</td></tr>)}</tbody>
            </table>
          }
        />
        <ChartCard
          testId="card-control-trend"
          title="Trend"
          subtitle={trend.data && variant.singleSnapshot && trend.data.points.length < 2 ? `${def.id} compliance rate (%), open matters. One snapshot so far.` : trend.data ? `${def.id} compliance rate (%), weekly snapshots, ${trendRangeLabel(trend.data.points)}. All visible matters.` : `${def.id} compliance rate (%)`}
          chart={trend.isPending ? <Loading /> : trend.isError ? <ErrorState error={trend.error} /> :
            variant.singleSnapshot && trend.data.points.length < 2 ? <SingleSnapshot {...variant.singleSnapshot} /> :
            trend.data.points.length ? <TrendChart points={trend.data.points} yLabel="Compliance (%)" height={300} /> :
              <EmptyResults title="No snapshots yet">A snapshot is taken after every sync.</EmptyResults>}
          table={trend.data ? <TrendTable points={trend.data.points} valueLabel="Compliance" /> : null}
        />
      </div>
    </>
  );
}
