import type { BreakdownRow, ControlDef } from '../api/types';
import { useTip } from '../components/Tooltip';
import { fmtInt, fmtPct, fmtRate } from '../lib/format';
import { HEAT_BINS, heatBin } from './heat';

export function HeatScaleLegend() {
  return (
    <div className="scale-legend" aria-label="Colour scale">
      <span>Compliance rate</span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span className="steps" aria-hidden="true">
          {HEAT_BINS.map((b, i) => <span key={b.label} className={`h${i}`} />)}
        </span>
        <span className="ticks">{HEAT_BINS.map((b) => <span key={b.label}>{b.label}</span>)}</span>
      </span>
      <span className="muted">Stronger colour = lower compliance. Select a cell to see its failing matters.</span>
    </div>
  );
}

export function Heatmap({ rows, controls, rowHeader, onCell }: {
  rows: BreakdownRow[];
  controls: ControlDef[];
  rowHeader: string;
  onCell: (row: BreakdownRow, controlId: string) => void;
}) {
  const tip = useTip();
  return (
    <div className="heatmap-wrap" data-testid="heatmap">
      <table className="heatmap">
        <caption className="visually-hidden">
          Compliance rate by {rowHeader.toLowerCase()} and control. Each cell is a button that opens the matching failing matters.
        </caption>
        <thead>
          <tr>
            <th scope="col" style={{ textAlign: 'left', fontFamily: 'inherit' }}>{rowHeader}</th>
            {controls.map((c) => <th key={c.id} scope="col" title={c.name}>{c.id}</th>)}
            <th scope="col" title="Mean matter readiness" style={{ fontFamily: 'inherit' }}>Readiness</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" title={r.label}>{r.label}<span className="cnt">{fmtInt(r.matters)}</span></th>
              {controls.map((c) => {
                const cell = r.cells.find((x) => x.control_id === c.id);
                const rate = cell?.compliance_rate ?? null;
                if (rate === null || !cell)
                  return (
                    <td key={c.id}>
                      <span className="heat-cell na" style={{ display: 'grid', placeItems: 'center' }} aria-label={`${r.label}, ${c.id}: no rated matters`}>–</span>
                    </td>
                  );
                const failing = cell.applicable - cell.passing;
                const content = (
                  <div>
                    <div style={{ fontWeight: 650, fontSize: 14 }}>{fmtRate(rate, 1)} compliant</div>
                    <div className="secondary">{r.label} · {c.id} {c.name}</div>
                    <div>{fmtInt(cell.passing)} of {fmtInt(cell.applicable)} applicable matters pass</div>
                  </div>
                );
                return (
                  <td key={c.id}>
                    <button type="button" className={`heat-cell h${heatBin(rate)}`}
                      aria-label={`${r.label}, ${c.id} ${c.name}: ${fmtRate(rate)} compliant, ${fmtInt(cell.passing)} of ${fmtInt(cell.applicable)}. Show ${fmtInt(failing)} failing matters.`}
                      onClick={() => onCell(r, c.id)}
                      onPointerMove={(e) => tip.show(e, content)} onPointerLeave={tip.hide}
                      onFocus={(e) => tip.show(e.currentTarget.getBoundingClientRect(), content)} onBlur={tip.hide}>
                      {fmtRate(rate)}
                    </button>
                  </td>
                );
              })}
              <td className="num" style={{ textAlign: 'center', fontWeight: 600 }}>{fmtPct(r.readiness, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {tip.node}
    </div>
  );
}

export function HeatmapTable({ rows, controls, rowHeader }: { rows: BreakdownRow[]; controls: ControlDef[]; rowHeader: string }) {
  return (
    <table className="data">
      <thead>
        <tr>
          <th>{rowHeader}</th><th className="num">Matters</th><th className="num">Readiness</th>
          {controls.map((c) => <th key={c.id} className="num" title={c.name}>{c.id}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td>{r.label}</td><td className="num">{fmtInt(r.matters)}</td><td className="num">{fmtPct(r.readiness)}</td>
            {controls.map((c) => {
              const cell = r.cells.find((x) => x.control_id === c.id);
              return (
                <td key={c.id} className="num">
                  {cell ? `${fmtRate(cell.compliance_rate)} (${cell.passing}/${cell.applicable})` : '—'}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
