import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { errorMessage } from '../api/client';
import { fmtDateTime } from '../lib/format';
import type { ExportButtonProps } from '../lib/variant';
import { usePortal } from './store';
import { copyText, useClearData } from './actions';

/**
 * Shows text in a selectable box when the clipboard is unavailable (for example
 * in a sandboxed frame), so it can be copied with Ctrl+C.
 */
export function CopyPanel({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    area.current?.focus();
    area.current?.select();
  }, []);
  return (
    <dialog ref={ref} className="modal" aria-labelledby="copy-title" onClose={onClose} data-testid="copy-panel">
      <div className="modal-body">
        <h2 id="copy-title">{title}</h2>
        <p className="secondary small">This browser did not allow automatic copying. The text below is selected: press Ctrl+C (Cmd+C on a Mac) to copy it, then paste it into Excel or a document.</p>
        <textarea ref={area} className="copy-area" readOnly value={text} aria-label={title} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <div className="modal-foot">
        <button type="button" className="btn" onClick={() => { area.current?.select(); }}>Select all</button>
        <button type="button" className="btn primary" onClick={() => ref.current?.close()}>Done</button>
      </div>
    </dialog>
  );
}

/** Portal replacement for "Export CSV": no downloads; copy the same (formula-escaped) CSV to the clipboard. */
export function CopyCsvButton({ build, label, disabled }: ExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [fallback, setFallback] = useState<string | null>(null);
  async function onClick() {
    setBusy(true);
    setMsg('');
    try {
      const csv = await build();
      if (await copyText(csv)) {
        const rows = Math.max(0, csv.split('\r\n').filter(Boolean).length - 1);
        setMsg(`Copied ${rows.toLocaleString('en-IE')} row${rows === 1 ? '' : 's'} as CSV. Paste into Excel.`);
      } else setFallback(csv);
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="row">
      <button type="button" className="btn small" onClick={() => void onClick()} disabled={busy || disabled}>
        <Icon name="copy" size={14} />
        {busy ? 'Preparing…' : label && label !== 'Export CSV' ? label : 'Copy as CSV'}
      </button>
      {msg ? <span className="small secondary" role="status" aria-live="polite">{msg}</span> : <span className="visually-hidden" role="status" aria-live="polite" />}
      {fallback !== null ? <CopyPanel title="Copy as CSV" text={fallback} onClose={() => setFallback(null)} /> : null}
    </span>
  );
}

export function PortalTopbar() {
  const { dataset } = usePortal();
  const clear = useClearData();
  if (!dataset) {
    return <span className="badge-live"><Icon name="lock" size={13} /> No file imported</span>;
  }
  const r = dataset.report;
  return (
    <>
      {r.isSample ? (
        <span className="badge-import sample" title="The bundled sample export. Every name in it is fictional.">
          <Icon name="alert" size={13} /> Sample file (fictional)
        </span>
      ) : (
        <span className="badge-import" title="Results computed in this tab from the file you imported.">
          <Icon name="file" size={13} /> Imported file
        </span>
      )}
      <span className="topbar-file" data-testid="imported-file" title={r.documentFile}>
        {r.isSample ? 'Sample export' : r.documentFile} · imported <strong>{fmtDateTime(dataset.importedAt)}</strong>
      </span>
      <button type="button" className="btn small" onClick={clear} data-testid="clear-data">
        <Icon name="trash" size={14} /> Clear data
      </button>
    </>
  );
}

export function PortalCoverage() {
  const { dataset } = usePortal();
  if (!dataset) return null;
  const r = dataset.report;
  const source = r.isSample ? 'the fictional sample export' : r.documentFile;
  return (
    <div className="coverage" data-testid="coverage">
      <Icon name="info" />
      <span className="grow">
        Based on <strong>{r.matters.toLocaleString('en-IE')} matters</strong> / <strong>{r.documentsUsed.toLocaleString('en-IE')} documents</strong> from{' '}
        <strong>{source}</strong>. Held only in this browser tab. Results show filing evidence in iManage, not whether a step happened.
      </span>
      {r.notes.length ? (
        <details>
          <summary>About this import ({r.notes.length} {r.notes.length === 1 ? 'note' : 'notes'})</summary>
          <ul>{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}
