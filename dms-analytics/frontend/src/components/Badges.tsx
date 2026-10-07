import type { ControlStatus } from '../api/types';
import { RISK_LABEL, STATUS, riskLevel } from '../lib/status';
import { Icon } from './Icon';

export function StatusPill({ status }: { status: ControlStatus }) {
  const m = STATUS[status];
  return (
    <span className={`pill ${m.cls}`} title={m.help}>
      <Icon name={m.icon} size={13} className="ico" />
      {m.label}
    </span>
  );
}

export function RiskBadge({ score }: { score: number | null | undefined }) {
  const lvl = riskLevel(score);
  return (
    <span className={`risk ${lvl}`} title={`Risk score ${score ?? 'not available'} (0 = no failing controls, 100 = all failing)`}>
      <span className="dot" aria-hidden="true" />
      <span>{score === null || score === undefined ? '—' : Math.round(score)}</span>
      <span className="lvl">{RISK_LABEL[lvl]}</span>
    </span>
  );
}

export function ModeBadge({ mode }: { mode: 'mock' | 'live' | undefined }) {
  if (mode === 'mock')
    return (
      <span className="badge-mock" title="Synthetic demonstration data. Nothing here comes from the firm's DMS.">
        <Icon name="alert" size={13} /> Demo data
      </span>
    );
  if (mode === 'live')
    return (
      <span className="badge-live">
        <Icon name="lock" size={13} /> Live · read-only
      </span>
    );
  return null;
}
