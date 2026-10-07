import { useState } from 'react';
import { errorMessage } from '../api/client';
import { saveCsv, stampedName } from '../lib/csv';
import { useVariant, type ExportButtonProps } from '../lib/variant';
import { Icon } from './Icon';

/** The export button for this build variant (the portal copies instead of saving). */
export function ExportButton(props: ExportButtonProps) {
  const Override = useVariant().ExportButton;
  return Override ? <Override {...props} /> : <SaveCsvButton {...props} />;
}

/** Builds the CSV on demand (may page through the API) and asks where to save it. */
function SaveCsvButton({ build, filename, label = 'Export CSV', disabled }: ExportButtonProps) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function onClick() {
    setBusy(true);
    setMsg(null);
    try {
      const csv = await build();
      const r = await saveCsv(stampedName(filename), csv);
      setMsg(r === 'saved' ? 'Saved.' : r === 'downloaded' ? 'Export ready. Choose where to keep it in your browser.' : 'Export cancelled.');
    } catch (e) {
      setMsg(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="row">
      <button type="button" className="btn small" onClick={onClick} disabled={busy || disabled}>
        <Icon name="download" size={14} />
        {busy ? 'Preparing…' : label}
      </button>
      <span className="visually-hidden" role="status" aria-live="polite">{msg ?? ''}</span>
    </span>
  );
}
