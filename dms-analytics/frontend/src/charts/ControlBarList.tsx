import { Link } from 'react-router';
import type { ControlDef, ControlTally } from '../api/types';
import { useTip } from '../components/Tooltip';
import { fmtInt, fmtRate } from '../lib/format';
import { STACK_KEYS, sortByRate } from './tally';

const LABEL = { pass: 'Pass', late: 'Late', missing: 'Missing', stale: 'Stale' } as const;

export function StatusLegend() {
  return (
    <div className="chart-legend" aria-label="Legend">
      {STACK_KEYS.map((k) => (
        <span key={k} className="key"><span className={`swatch ${k}`} aria-hidden="true" />{LABEL[k]}</span>
      ))}
      <span className="key muted">Pending, N/A and unknown are excluded from the rate.</span>
    </div>
  );
}

/**
 * Horizontal stacked bar list: one row per control, pass/late/missing/stale shares
 * of the rated results. Rows link to that control's exceptions.
 */
export function ControlBarList({ tallies, controls, linkFor }: {
  tallies: ControlTally[];
  controls: ControlDef[];
  linkFor: (controlId: string) => string;
}) {
  const tip = useTip();
  const byId = new Map(controls.map((c) => [c.id, c]));
  return (
    <div className="barlist" data-testid="control-bars">
      <div className="barlist-head" aria-hidden="true">
        <span>Control</span><span style={{ textAlign: 'right' }}>Rate</span><span>Results on file</span><span style={{ textAlign: 'right' }}>Failing</span>
      </div>
      {sortByRate(tallies).map((t) => {
        const def = byId.get(t.control_id);
        const rated = t.pass + t.late + t.missing + t.stale;
        const failing = t.late + t.missing + t.stale;
        const name = def?.name ?? t.control_id;
        const parts = [t.late && `${fmtInt(t.late)} late`, t.missing && `${fmtInt(t.missing)} missing`, t.stale && `${fmtInt(t.stale)} stale`].filter(Boolean);
        const aria = `${t.control_id} ${name}: ${fmtRate(t.compliance_rate)} compliant. ${fmtInt(t.pass)} pass${parts.length ? ', ' + parts.join(', ') : ''}. Show exceptions.`;
        return (
          <Link key={t.control_id} to={linkFor(t.control_id)} className="barrow" aria-label={aria}
            onFocus={(e) => tip.show(e.currentTarget.getBoundingClientRect(), <TipBody t={t} name={name} />)} onBlur={tip.hide}>
            <span className="ctl-name" title={name}>
              <span className="ctl-id">{t.control_id}</span>
              <strong>{name}{def && !def.configured ? ' (not configured)' : ''}</strong>
            </span>
            <span className="rate">{fmtRate(t.compliance_rate)}</span>
            <span className="stack" aria-hidden="true" onPointerLeave={tip.hide}>
              {rated === 0 ? <span className="s-pending" style={{ width: '100%' }} /> : STACK_KEYS.filter((k) => t[k] > 0).map((k) => (
                <span key={k} className={`s-${k}`} style={{ width: `${(100 * t[k]) / rated}%` }}
                  onPointerMove={(e) => tip.show(e, <TipBody t={t} name={name} focus={k} />)} />
              ))}
            </span>
            <span className="counts">{failing ? fmtInt(failing) : 'None'}</span>
          </Link>
        );
      })}
      {tip.node}
    </div>
  );
}

function TipBody({ t, name, focus }: { t: ControlTally; name: string; focus?: (typeof STACK_KEYS)[number] }) {
  return (
    <div>
      <div style={{ fontWeight: 650, fontSize: 14 }}>{fmtRate(t.compliance_rate, 1)} compliant</div>
      <div className="secondary" style={{ marginBottom: 4 }}>{t.control_id} · {name}</div>
      {STACK_KEYS.map((k) => (
        <div key={k} className="row" style={{ gap: 6, fontWeight: focus === k ? 650 : 400 }}>
          <span className={`swatch ${k}`} aria-hidden="true" /> <span className="num">{fmtInt(t[k])}</span> {LABEL[k].toLowerCase()}
        </div>
      ))}
      {t.pending ? <div className="muted">{fmtInt(t.pending)} pending (not due yet)</div> : null}
    </div>
  );
}

export function ControlTallyTable({ tallies, controls }: { tallies: ControlTally[]; controls: ControlDef[] }) {
  const byId = new Map(controls.map((c) => [c.id, c]));
  return (
    <table className="data">
      <thead>
        <tr>
          <th>Control</th><th className="num">Compliance</th><th className="num">Pass</th><th className="num">Late</th>
          <th className="num">Missing</th><th className="num">Stale</th><th className="num">Pending</th><th className="num">N/A</th><th className="num">Unknown</th>
        </tr>
      </thead>
      <tbody>
        {sortByRate(tallies).map((t) => (
          <tr key={t.control_id}>
            <td><span className="tag">{t.control_id}</span> {byId.get(t.control_id)?.name}</td>
            <td className="num">{fmtRate(t.compliance_rate, 1)}</td>
            <td className="num">{fmtInt(t.pass)}</td><td className="num">{fmtInt(t.late)}</td><td className="num">{fmtInt(t.missing)}</td>
            <td className="num">{fmtInt(t.stale)}</td><td className="num">{fmtInt(t.pending)}</td><td className="num">{fmtInt(t.not_applicable)}</td>
            <td className="num">{fmtInt(t.unknown)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
