import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useBreakdown, useControls, usePortfolioSummary, useTrend } from '../api/hooks';
import type { Dimension } from '../api/types';
import { ChartCard } from '../components/ChartCard';
import { FilterBar } from '../components/FilterBar';
import { PageHead } from '../components/Layout';
import { EmptyResults, ErrorState, Loading } from '../components/States';
import { ControlBarList, ControlTallyTable, StatusLegend } from '../charts/ControlBarList';
import { Heatmap, HeatmapTable, HeatScaleLegend } from '../charts/Heatmap';
import { TrendChart, TrendTable } from '../charts/TrendChart';
import { heatmapCellLink } from '../lib/links';
import { ExportButton } from '../components/ExportButton';
import { toCsv } from '../lib/csv';
import { fmtInt, fmtPct, trendRangeLabel } from '../lib/format';
import { DIMENSIONS } from '../lib/status';
import { filterQuery, useGlobalFilters, type GlobalFilters } from '../state/filters';

function scopeText(f: GlobalFilters): string {
  const s = f.status ?? 'open';
  return s === 'all' ? 'all matters' : `${s} matters`;
}

export function PortfolioPage() {
  const { filters } = useGlobalFilters();
  const navigate = useNavigate();
  const [dimension, setDimension] = useState<Dimension>('practice_area');
  const summary = usePortfolioSummary(filters);
  const controls = useControls();
  const breakdown = useBreakdown(dimension, filters);
  const trend = useTrend(undefined);
  const dimLabel = DIMENSIONS.find((d) => d.value === dimension)!.label;

  const head = (
    <PageHead title="Portfolio" lead={`Lexcel readiness and control compliance across ${scopeText(filters)} visible to you.`} />
  );

  if (summary.isPending || controls.isPending) return <>{head}<FilterBar /><div className="card"><Loading label="Loading portfolio…" /></div></>;
  if (summary.isError) return <>{head}<FilterBar /><div className="card"><ErrorState error={summary.error} onRetry={() => void summary.refetch()} /></div></>;
  if (controls.isError) return <>{head}<FilterBar /><div className="card"><ErrorState error={controls.error} onRetry={() => void controls.refetch()} /></div></>;

  const s = summary.data;
  const defs = controls.data;
  const qs = filterQuery(filters);
  const refetching = summary.isPlaceholderData ? 'refetching' : '';

  return (
    <>
      {head}
      <FilterBar />
      {s.scope.matters === 0 ? (
        <div className="card"><EmptyResults title="No matters match these filters">Try clearing one or more filters.</EmptyResults></div>
      ) : (
        <div className={`stack-v ${refetching}`} style={{ gap: 16 }}>
          <section className="kpis" aria-label="Headline figures">
            <div className="card kpi hero" data-testid="kpi-readiness">
              <span className="kpi-label">Lexcel readiness</span>
              <span className="kpi-value">{fmtPct(s.readiness)}</span>
              <div className="meter" aria-hidden="true"><span style={{ width: `${s.readiness ?? 0}%` }} /></div>
              <span className="kpi-note">Mean across {fmtInt(s.scope.matters)} matters in scope</span>
            </div>
            <Link className="card kpi" to={`/matters${qs}`} data-testid="kpi-open">
              <span className="kpi-label">Open matters</span>
              <span className="kpi-value">{fmtInt(s.scope.open_matters)}</span>
              <span className="kpi-note">{fmtInt(s.scope.matters)} matters in scope</span>
            </Link>
            <Link className="card kpi" to={`/matters${filterQuery(filters, { min_risk: '50' })}`} data-testid="kpi-high-risk">
              <span className="kpi-label">High-risk matters</span>
              <span className="kpi-value">{fmtInt(s.high_risk_matters)}</span>
              <span className="kpi-note">Risk score 50 or more</span>
            </Link>
            <Link className="card kpi" to={`/exceptions${qs}`} data-testid="kpi-exceptions">
              <span className="kpi-label">Open exceptions</span>
              <span className="kpi-value">{fmtInt(s.exceptions_open)}</span>
              <span className="kpi-note">Late, missing or stale results</span>
            </Link>
            <Link className="card kpi" to="/key-dates" data-testid="kpi-key-dates">
              <span className="kpi-label">Key dates, next 30 days</span>
              <span className="kpi-value">{fmtInt(s.upcoming_key_dates.d30)}</span>
              <span className="kpi-note">{fmtInt(s.upcoming_key_dates.d60)} in 60 days · {fmtInt(s.upcoming_key_dates.d90)} in 90 days</span>
            </Link>
          </section>

          <div className="grid-2">
            <ChartCard
              testId="card-controls"
              title="Control compliance"
              subtitle={`Share of rated results that pass, ${scopeText(filters)}. Lowest first. Select a control to see its exceptions.`}
              legend={<StatusLegend />}
              actions={
                <ExportButton filename="control-compliance" build={() => toCsv(
                  ['control_id', 'control', 'compliance_rate', 'pass', 'late', 'missing', 'stale', 'pending', 'not_applicable', 'unknown'],
                  s.controls.map((t) => [t.control_id, defs.find((d) => d.id === t.control_id)?.name, t.compliance_rate, t.pass, t.late, t.missing, t.stale, t.pending, t.not_applicable, t.unknown]),
                )} />
              }
              chart={<ControlBarList tallies={s.controls} controls={defs} linkFor={(id) => `/exceptions${filterQuery(filters, { control_id: id })}`} />}
              table={<ControlTallyTable tallies={s.controls} controls={defs} />}
            />
            <div className="stack-v" style={{ gap: 16 }}>
              <ChartCard
                testId="card-trend"
                title="Readiness trend"
                subtitle={trend.data ? `Portfolio readiness (%), weekly snapshots, ${trendRangeLabel(trend.data.points)}. All visible matters.` : 'Portfolio readiness (%)'}
                actions={trend.data ? (
                  <ExportButton filename="readiness-trend" build={() => toCsv(['snapshot', 'readiness_pct', 'passing', 'applicable'],
                    trend.data.points.map((p) => [p.taken_at, p.value, p.passing, p.applicable]))} />
                ) : null}
                chart={trend.isPending ? <Loading /> : trend.isError ? <ErrorState error={trend.error} /> :
                  trend.data.points.length ? <TrendChart points={trend.data.points} yLabel="Readiness (%)" /> :
                    <EmptyResults title="No snapshots yet">A snapshot is taken after every sync.</EmptyResults>}
                table={trend.data ? <TrendTable points={trend.data.points} valueLabel="Readiness" /> : null}
              />
              <section className="card" aria-labelledby="how-read">
                <div className="card-head"><div className="titles"><h2 id="how-read">How to read these figures</h2></div></div>
                <div className="card-body secondary small stack-v" style={{ gap: 6 }}>
                  <p><strong>Readiness</strong> is 100 minus a matter's risk score, averaged across matters. A matter's risk score weights each failing control by its severity (1–3).</p>
                  <p><strong>Compliance rate</strong> is pass ÷ (pass + late + missing + stale). Pending, not applicable and unknown results are left out.</p>
                  <p>Every result is based on iManage filing evidence: it shows whether evidence is on file, not whether the step happened.</p>
                </div>
              </section>
            </div>
          </div>

          <ChartCard
            testId="card-heatmap"
            title={`Compliance by ${dimLabel.toLowerCase()} and control`}
            subtitle={`Compliance rate (%) per control, ${scopeText(filters)}. Number beside each row = matters.`}
            legend={<HeatScaleLegend />}
            actions={
              <>
                <label htmlFor="heat-dim" className="small secondary">Rows</label>
                <select id="heat-dim" className="select" style={{ height: 28 }} value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
                  {DIMENSIONS.map((d) => <option key={d.value} value={d.value}>{d.label}</option>)}
                </select>
                {breakdown.data ? (
                  <ExportButton filename={`compliance-by-${dimension}`} build={() => toCsv(
                    [dimLabel, 'matters', 'readiness_pct', ...defs.map((d) => `${d.id}_rate`)],
                    breakdown.data.rows.map((r) => [r.label, r.matters, r.readiness, ...defs.map((d) => r.cells.find((c) => c.control_id === d.id)?.compliance_rate)]),
                  )} />
                ) : null}
              </>
            }
            chart={breakdown.isPending ? <Loading /> : breakdown.isError ? <ErrorState error={breakdown.error} onRetry={() => void breakdown.refetch()} /> :
              breakdown.data.rows.length === 0 ? <EmptyResults title="Nothing to show for these filters" /> : (
                <div className={breakdown.isPlaceholderData ? 'refetching' : ''}>
                  <Heatmap rows={breakdown.data.rows} controls={defs} rowHeader={dimLabel}
                    onCell={(row, controlId) => navigate(heatmapCellLink(filters, dimension, row, controlId))} />
                </div>
              )}
            table={breakdown.data ? <HeatmapTable rows={breakdown.data.rows} controls={defs} rowHeader={dimLabel} /> : null}
          />
        </div>
      )}
    </>
  );
}
