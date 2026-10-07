import { fmtInt, fmtRate } from '../lib/format';
import { useTip } from '../components/Tooltip';

export interface RateBarDatum { key: string; label: string; rate: number | null; passing: number; applicable: number; href?: string }

/** One series of horizontal bars (compliance rate, 0–100 %), value at the bar tip. */
export function RateBars({ data, onSelect }: { data: RateBarDatum[]; onSelect?: (d: RateBarDatum) => void }) {
  const tip = useTip();
  return (
    <div className="stack-v" style={{ gap: 4 }} data-testid="rate-bars">
      <div className="ratebar-axis muted small" aria-hidden="true" style={{ display: 'grid', gridTemplateColumns: '160px 1fr 110px', gap: 12, padding: '0 6px' }}>
        <span /><span style={{ display: 'flex', justifyContent: 'space-between' }}><span>0%</span><span>50%</span><span>100%</span></span><span />
      </div>
      {data.map((d) => {
        const content = (
          <div><div style={{ fontWeight: 650, fontSize: 14 }}>{fmtRate(d.rate, 1)}</div>
            <div className="secondary">{d.label}</div><div>{fmtInt(d.passing)} of {fmtInt(d.applicable)} pass</div></div>
        );
        const inner = (
          <>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 550 }}>{d.label}</span>
            <span style={{ position: 'relative', height: 14, background: 'linear-gradient(to right, var(--grid) 1px, transparent 1px) 0 0 / 50% 100%' }}>
              {d.rate !== null ? <span className="mini-bar" style={{ display: 'block', height: 14, width: `${d.rate * 100}%`, maxHeight: 14 }} /> : null}
            </span>
            <span className="num" style={{ fontWeight: 600 }}>{fmtRate(d.rate)} <span className="muted small">({fmtInt(d.applicable - d.passing)} fail)</span></span>
          </>
        );
        const style = { display: 'grid', gridTemplateColumns: '160px 1fr 110px', gap: 12, alignItems: 'center', padding: '5px 6px', borderRadius: 6 } as const;
        return onSelect ? (
          <button key={d.key} type="button" className="barrow-btn" style={{ ...style, border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer' }}
            aria-label={`${d.label}: ${fmtRate(d.rate)} compliant, ${d.passing} of ${d.applicable}. Show failing matters.`}
            onClick={() => onSelect(d)} onPointerMove={(e) => tip.show(e, content)} onPointerLeave={tip.hide}
            onFocus={(e) => tip.show(e.currentTarget.getBoundingClientRect(), content)} onBlur={tip.hide}>
            {inner}
          </button>
        ) : (
          <div key={d.key} style={style}>{inner}</div>
        );
      })}
      {tip.node}
    </div>
  );
}
