import { Link, useNavigate, useParams } from 'react-router';
import { ApiError } from '../api/client';
import { useControls, useMatter } from '../api/hooks';
import { RiskBadge, StatusPill } from '../components/Badges';
import { ExportButton } from '../components/ExportButton';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Layout';
import { EmptyResults, ErrorState, Loading } from '../components/States';
import { toCsv } from '../lib/csv';
import { fmtDate, fmtInt, fmtPct } from '../lib/format';
import { BASIS_TEXT, STATUS, typeLabel } from '../lib/status';

const KIND_LABEL = {
  opened: 'Opened', first_substantive: 'First substantive document', evidence: 'Evidence filed', key_date: 'Key date', last_activity: 'Last activity',
} as const;
const STATUS_ORDER = ['missing', 'late', 'stale', 'unknown', 'pending', 'pass', 'not_applicable'];

export function MatterDetailPage() {
  const { matterId = '' } = useParams();
  const navigate = useNavigate();
  const matter = useMatter(matterId);
  const controls = useControls();
  const back = (
    <button type="button" className="btn ghost small no-print" onClick={() => navigate(-1)} style={{ alignSelf: 'flex-start', marginLeft: -10 }}>
      <Icon name="back" size={14} /> Back
    </button>
  );

  if (matter.isPending) return <>{back}<div className="card"><Loading label="Loading matter…" /></div></>;
  if (matter.isError) {
    if (matter.error instanceof ApiError && matter.error.status === 404)
      return <>{back}<div className="card"><EmptyResults title="Matter not found">{matter.error.message} <Link to="/matters">Back to matters</Link></EmptyResults></div></>;
    return <>{back}<div className="card"><ErrorState error={matter.error} onRetry={() => void matter.refetch()} /></div></>;
  }
  const m = matter.data;
  const ctl = (id: string) => controls.data?.find((c) => c.id === id);
  const results = [...m.controls].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.control_id.localeCompare(b.control_id));
  const maxCount = Math.max(1, ...m.doc_type_counts.map((d) => d.count));
  const docTypes = [...m.doc_type_counts].sort((a, b) => b.count - a.count);

  return (
    <>
      {back}
      <PageHead
        title={<>{m.matter_code} · {m.matter_name}</>}
        lead={<>{m.client_name} ({m.client_code})</>}
        actions={<>
          <RiskBadge score={m.risk_score} />
          <span className="secondary">Readiness <strong>{m.risk_score === null ? '—' : fmtPct(100 - m.risk_score)}</strong></span>
          <ExportButton filename={`matter-${m.matter_code}-controls`} build={() => toCsv(
            ['control_id', 'control', 'status', 'due', 'evidence_filed', 'days_late', 'explanation', 'evidence_documents'],
            m.controls.map((c) => [c.control_id, ctl(c.control_id)?.name, c.status, c.due_at?.slice(0, 10), c.evidence_at?.slice(0, 10), c.days_late,
              c.explanation, (c.evidence ?? []).map((e) => `${e.name} (${e.filed_at.slice(0, 10)})`).join('; ')]),
          )} />
        </>}
      />
      <section className="card" aria-labelledby="profile-h">
        <div className="card-head"><div className="titles"><h2 id="profile-h">Profile</h2></div></div>
        <div className="card-body">
          <dl className="profile">
            <div><dt>Practice area</dt><dd>{m.practice_area ?? '—'}</dd></div>
            <div><dt>Partner</dt><dd>{m.partner?.name ?? '—'}</dd></div>
            <div><dt>Fee earner</dt><dd>{m.fee_earner?.name ?? '—'}</dd></div>
            <div><dt>Office</dt><dd>{m.office ?? '—'}</dd></div>
            <div><dt>Status</dt><dd>{m.status === 'open' ? 'Open' : 'Closed'}</dd></div>
            <div><dt>Opened</dt><dd>{fmtDate(m.opened_at)}</dd></div>
            <div><dt>Last activity</dt><dd>{fmtDate(m.last_activity_at)}</dd></div>
            <div><dt>Key date</dt><dd>{fmtDate(m.key_date)}</dd></div>
            <div><dt>Documents</dt><dd>{fmtInt(m.doc_count)}</dd></div>
            <div><dt>Failing controls</dt><dd>{m.failing_controls.length ? m.failing_controls.map((c) => <span key={c} className="tag">{c}</span>) : 'None'}</dd></div>
          </dl>
        </div>
      </section>

      <section className="card" aria-labelledby="results-h">
        <div className="card-head">
          <div className="titles"><h2 id="results-h">Control results</h2><div className="sub">{BASIS_TEXT}</div></div>
        </div>
        <div className="table-wrap">
          <table className="data" data-testid="control-results">
            <thead><tr><th>Control</th><th>Result</th><th>Explanation</th><th>Evidence on file</th></tr></thead>
            <tbody>
              {results.map((c) => (
                <tr key={c.control_id}>
                  <td style={{ minWidth: 200 }}><div className="cell-title"><span className="tag">{c.control_id}</span> {ctl(c.control_id)?.name}</div></td>
                  <td><StatusPill status={c.status} /></td>
                  <td className="secondary" style={{ minWidth: 260 }}>
                    {c.explanation || STATUS[c.status].help}
                    {c.due_at ? <div className="cell-sub">Due {fmtDate(c.due_at)}{c.days_late ? ` · ${c.days_late} days late` : ''}</div> : null}
                  </td>
                  <td style={{ minWidth: 220 }}>
                    {c.evidence?.length ? (
                      <ul style={{ margin: 0, paddingLeft: 16 }}>
                        {c.evidence.map((e) => <li key={e.id}>{e.name} <span className="cell-sub">filed {fmtDate(e.filed_at)}</span></li>)}
                      </ul>
                    ) : <span className="muted">None</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2-even">
        <section className="card" aria-labelledby="timeline-h">
          <div className="card-head"><div className="titles"><h2 id="timeline-h">Filing timeline</h2><div className="sub">Key filing events, oldest first.</div></div></div>
          <div className="card-body">
            {m.timeline.length ? (
              <ol className="timeline" data-testid="timeline">
                {m.timeline.map((t, i) => (
                  <li key={`${t.at}-${i}`}>
                    <span className="when">{fmtDate(t.at)}</span>
                    <span className={`node k-${t.kind}`} aria-hidden="true" />
                    <span>
                      <span style={{ fontWeight: 550 }}>{t.label}</span>
                      <span className="cell-sub" style={{ display: 'block' }}>{KIND_LABEL[t.kind]}{t.control_id ? ` · ${t.control_id}` : ''}</span>
                    </span>
                  </li>
                ))}
              </ol>
            ) : <EmptyResults title="No filing events recorded" />}
          </div>
        </section>
        <section className="card" aria-labelledby="types-h">
          <div className="card-head"><div className="titles"><h2 id="types-h">Documents by type</h2><div className="sub">Count of documents, by mapped document type.</div></div></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Type</th><th className="num">Documents</th><th style={{ width: '45%' }}><span className="visually-hidden">Bar</span></th></tr></thead>
              <tbody>
                {docTypes.map((d) => (
                  <tr key={d.canonical_type ?? 'other'}>
                    <td>{typeLabel(d.canonical_type)}</td>
                    <td className="num">{fmtInt(d.count)}</td>
                    <td style={{ verticalAlign: 'middle' }}><div className="mini-bar" style={{ width: `${(100 * d.count) / maxCount}%` }} aria-hidden="true" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </>
  );
}
