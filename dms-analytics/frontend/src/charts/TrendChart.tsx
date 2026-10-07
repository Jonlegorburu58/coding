import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";
import type { TrendPoint } from '../api/types';
import { fmtDate, fmtInt, fmtPct } from '../lib/format';

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' });

function TipContent({ active, payload }: TooltipContentProps<ValueType, NameType>) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload as TrendPoint;
  return (
    <div className="chart-tooltip">
      <div className="v">{fmtPct(p.value)}</div>
      <div className="l">{fmtDate(p.taken_at)}</div>
      <div className="l">{fmtInt(p.passing)} of {fmtInt(p.applicable)} passing</div>
    </div>
  );
}

/** Single-series line chart, 0–100 % on one axis, last value labelled directly. */
export function TrendChart({ points, yLabel, height = 260 }: { points: TrendPoint[]; yLabel: string; height?: number }) {
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const min = vals.length ? Math.max(0, Math.floor((Math.min(...vals) - 5) / 10) * 10) : 0;
  const last = points.length - 1;
  return (
    <div className="chart-box" style={{ height }} data-testid="trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 48, bottom: 8, left: 4 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--grid)" strokeWidth={1} />
          <XAxis dataKey="taken_at" tickFormatter={shortDate} tickLine={false} axisLine={{ stroke: 'var(--axis)' }}
            minTickGap={28} tickMargin={8} />
          <YAxis domain={[min, 100]} tickFormatter={(v: number) => `${v}%`} tickLine={false} axisLine={false} width={64}
            label={{ value: yLabel, angle: -90, position: 'insideLeft', offset: 10, style: { textAnchor: 'middle' } }} />
          <Tooltip content={TipContent} cursor={{ stroke: 'var(--axis)', strokeWidth: 1 }} isAnimationActive={false} />
          <Line type="monotone" dataKey="value" stroke="var(--accent-line)" strokeWidth={2} isAnimationActive={false}
            dot={(props: { cx?: number; cy?: number; index?: number; value?: number }) =>
              props.index === last && props.cx !== undefined && props.cy !== undefined ? (
                <g key="last">
                  <circle cx={props.cx} cy={props.cy} r={5} fill="var(--accent-line)" stroke="var(--surface)" strokeWidth={2} />
                  <text x={props.cx + 9} y={props.cy + 4} fontSize={12.5} fontWeight={650} fill="var(--ink)">{fmtPct(props.value ?? null, 1)}</text>
                </g>
              ) : <g key={`d${props.index}`} />
            }
            activeDot={{ r: 5, stroke: 'var(--surface)', strokeWidth: 2, fill: 'var(--accent-line)' }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function TrendTable({ points, valueLabel }: { points: TrendPoint[]; valueLabel: string }) {
  return (
    <table className="data">
      <thead><tr><th>Snapshot date</th><th className="num">{valueLabel}</th><th className="num">Passing</th><th className="num">Applicable</th></tr></thead>
      <tbody>
        {points.map((p) => (
          <tr key={p.taken_at}><td>{fmtDate(p.taken_at)}</td><td className="num">{fmtPct(p.value)}</td>
            <td className="num">{fmtInt(p.passing)}</td><td className="num">{fmtInt(p.applicable)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}
