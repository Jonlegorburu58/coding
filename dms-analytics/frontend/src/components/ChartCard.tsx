import { useId, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Chart container: title, subtitle (units and date range), a "View as table"
 * toggle (the accessible twin of every chart) and optional actions.
 */
export function ChartCard({ title, subtitle, actions, legend, chart, table, footer, testId, className }: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  footer?: ReactNode;
  testId?: string;
  className?: string;
}) {
  const [asTable, setAsTable] = useState(false);
  const headingId = useId();
  return (
    <section className={`card ${className ?? ''}`} aria-labelledby={headingId} data-testid={testId}>
      <div className="card-head">
        <div className="titles">
          <h2 id={headingId}>{title}</h2>
          {subtitle ? <div className="sub">{subtitle}</div> : null}
        </div>
        <div className="card-actions">
          {actions}
          <button type="button" className="btn small ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>
            <Icon name={asTable ? 'chart' : 'table'} size={14} />
            {asTable ? 'View as chart' : 'View as table'}
          </button>
        </div>
      </div>
      {legend && !asTable ? <div className="card-body" style={{ paddingBottom: 8 }}>{legend}</div> : null}
      <div className={asTable ? 'card-body flush' : 'card-body'}>{asTable ? <div className="table-wrap">{table}</div> : chart}</div>
      {footer ? <div className="card-foot">{footer}</div> : null}
    </section>
  );
}
