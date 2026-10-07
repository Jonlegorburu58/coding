import { useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '../components/Icon';
import { PageHead } from '../components/Layout';
import { CATALOGUE, type ControlId, type Thresholds } from './engine';
import { DOC_FIELDS, MATTER_FIELDS, normHeader, suggestMapping, type ColumnMapping, type FieldDef } from './columns';
import { parseDate, nowNaive, type DayOrder } from './dates';
import {
  INHERIT, TYPE_CHOICES, TYPE_LABEL, classKey, configuredTypes, distinctClasses, suggestType, withSuggestions,
  type ClassCount, type NameRule, type SubclassChoice, type TypeChoice,
} from './doctypes';
import { buildDataset, cellText, mappingErrors, resolveDayOrder } from './build';
import { ImportError, column, readTableFile, type Cell, type RawTable } from './readFile';
import { generateSampleExport } from './sample';
import {
  THRESHOLD_LABELS, defaultSettings, forgetSettings, parseSettingsText, saveSettings, serializeSettings, type PortalSettings,
} from './settings';
import { portalStore, usePortal, type Draft } from './store';
import { CopyPanel } from './chrome';
import { copyText, useClearData } from './actions';
import { CANONICAL_TYPES } from './engine';

type Step = 'files' | 'columns' | 'types';
const STEPS: { id: Step; label: string }[] = [
  { id: 'files', label: 'Choose files' }, { id: 'columns', label: 'Match columns' }, { id: 'types', label: 'Document types' },
];

const CLASS_HEADERS = new Set(DOC_FIELDS.find((f) => f.field === 'class')!.synonyms.map(normHeader));

/** A parsed (naive UTC) date; the time is shown only when the file gave one. */
const fmtParsed = (t: number | null) =>
  t === null ? null : new Date(t).toLocaleString('en-IE', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
    ...(t % 86_400_000 ? { hour: '2-digit', minute: '2-digit' } : {}),
  });

/** Apply column suggestions for the files in the draft (keeps choices that still fit). */
function suggestFor(draft: Draft, s: PortalSettings): PortalSettings {
  return {
    ...s,
    docColumns: draft.docs ? suggestMapping(draft.docs.headers, DOC_FIELDS, s.docColumns) : s.docColumns,
    matterColumns: draft.matters ? suggestMapping(draft.matters.headers, MATTER_FIELDS, s.matterColumns) : s.matterColumns,
  };
}

export function ImportPage() {
  const { draft, settings, dataset } = usePortal();
  const [step, setStep] = useState<Step>('files');
  const clear = useClearData();
  const stepIndex = STEPS.findIndex((x) => x.id === step);

  return (
    <>
      <PageHead
        title="Import an iManage export"
        lead="Drop in the Excel or CSV file you exported from an iManage Work search. It is read and checked inside this browser tab: nothing is uploaded, and closing the tab discards it."
        actions={dataset || draft.docs ? <button type="button" className="btn" onClick={clear}><Icon name="trash" size={14} /> Clear data</button> : null}
      />
      {dataset ? <CurrentImport onRemap={() => setStep('columns')} /> : null}
      <ol className="steps" aria-label="Import steps">
        {STEPS.map((x, i) => (
          <li key={x.id} aria-current={x.id === step ? 'step' : undefined} className={i < stepIndex ? 'done' : undefined}>{x.label}</li>
        ))}
      </ol>
      {step === 'files' ? <FilesStep draft={draft} settings={settings} onNext={() => setStep('columns')} /> : null}
      {step === 'columns' && draft.docs ? <ColumnsStep draft={draft} settings={settings} onBack={() => setStep('files')} onNext={() => setStep('types')} /> : null}
      {step === 'types' && draft.docs ? <TypesStep draft={draft} settings={settings} onBack={() => setStep('columns')} /> : null}
    </>
  );
}

function CurrentImport({ onRemap }: { onRemap: () => void }) {
  const { dataset, draft } = usePortal();
  const navigate = useNavigate();
  if (!dataset) return null;
  const r = dataset.report;
  return (
    <section className="card" aria-labelledby="current-h" data-testid="current-import">
      <div className="card-head">
        <div className="titles">
          <h2 id="current-h">Current import</h2>
          <div className="sub">{r.isSample ? 'Fictional sample export' : r.documentFile}{r.matterFile && !r.isSample ? ` + ${r.matterFile}` : ''}</div>
        </div>
        <div className="card-actions">
          {draft.docs ? <button type="button" className="btn small" onClick={onRemap}>Change mapping</button> : null}
          <button type="button" className="btn small primary" onClick={() => navigate('/')}>Open dashboard</button>
        </div>
      </div>
      <div className="card-body stat-row">
        <span><strong>{r.matters.toLocaleString('en-IE')}</strong> matters</span>
        <span><strong>{r.documentsUsed.toLocaleString('en-IE')}</strong> documents</span>
        {r.versionsMerged ? <span><strong>{r.versionsMerged.toLocaleString('en-IE')}</strong> extra versions combined</span> : null}
        {r.skippedNoCreated + r.skippedNoMatter ? <span className="warn-ink"><strong>{(r.skippedNoCreated + r.skippedNoMatter).toLocaleString('en-IE')}</strong> rows left out</span> : null}
        <span>Dates read as <strong>{r.dayOrder === 'dmy' ? 'day/month/year' : 'month/day/year'}</strong></span>
        {r.unknownControls.length ? <span>Cannot be checked: <strong>{r.unknownControls.join(', ')}</strong></span> : null}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 1: files

function FilesStep({ draft, settings, onNext }: { draft: Draft; settings: PortalSettings; onNext: () => void }) {
  const [busy, setBusy] = useState(false);
  function setTable(kind: 'docs' | 'matters', t: RawTable | null) {
    const next: Draft = { ...draft, [kind]: t, isSample: false };
    if (draft.isSample) next[kind === 'docs' ? 'matters' : 'docs'] = null;
    portalStore.setDraft(next);
    portalStore.setSettings(suggestFor(next, settings));
  }
  function loadSample() {
    setBusy(true);
    setTimeout(() => {
      const s = generateSampleExport(nowNaive());
      const next: Draft = { docs: s.docs, matters: s.matters, isSample: true };
      portalStore.setDraft(next);
      portalStore.setSettings(suggestFor(next, settings));
      setBusy(false);
      onNext();
    }, 0);
  }
  return (
    <>
      <div className="import-grid">
        <FileDrop title="Document list" required testId="drop-docs"
          help="The search results exported from iManage Work: one row per document, with class, dates, client and matter."
          table={draft.docs} onTable={(t) => setTable('docs', t)} />
        <FileDrop title="Matter list" testId="drop-matters"
          help="Optional. One row per matter: client, matter, name, practice area, partner, fee earner, office, status, open/close date, type and key date."
          table={draft.matters} onTable={(t) => setTable('matters', t)} />
      </div>
      <div className="sticky-actions">
        <span className="small secondary" style={{ marginRight: 'auto' }}>No file to hand? The sample is an invented firm, shaped like an iManage export.</span>
        <button type="button" className="btn" onClick={loadSample} disabled={busy} data-testid="load-sample">
          <Icon name="database" size={14} /> {busy ? 'Preparing sample…' : 'Load sample export'}
        </button>
        <button type="button" className="btn primary" onClick={onNext} disabled={!draft.docs}>Continue</button>
      </div>
      <div className="import-grid">
        <HowTo />
        <SettingsTools draft={draft} settings={settings} />
      </div>
    </>
  );
}

function FileDrop({ title, help, required, table, onTable, testId }: {
  title: string; help: string; required?: boolean; table: RawTable | null; onTable: (t: RawTable | null) => void; testId: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function read(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onTable(await readTableFile(file));
    } catch (e) {
      setError(e instanceof ImportError ? e.message : 'This file could not be read. Export it again as .xlsx or .csv.');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void read(e.dataTransfer.files[0]);
  }
  const id = `${testId}-input`;
  return (
    <section className="card" aria-labelledby={`${testId}-h`}>
      <div className="card-head">
        <div className="titles">
          <h2 id={`${testId}-h`}>{title}{required ? <span className="req" aria-hidden="true">*</span> : <span className="muted small"> (optional)</span>}</h2>
          <div className="sub">{help}</div>
        </div>
      </div>
      <div className="card-body">
        <div className={`dropzone${over ? ' over' : ''}${table ? ' has-file' : ''}`} data-testid={testId}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}>
          {table ? (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="file-chip">
                <Icon name="file" size={20} />
                <span>
                  <span className="file-name">{table.fileName}</span>
                  <span className="cell-sub" style={{ display: 'block' }}>
                    {table.rows.length.toLocaleString('en-IE')} rows · {table.headers.length} columns{table.sheetName ? ` · sheet “${table.sheetName}”` : ''}
                  </span>
                </span>
              </span>
              <span className="row">
                <button type="button" className="btn small" onClick={() => input.current?.click()}>Replace</button>
                <button type="button" className="btn small ghost" onClick={() => onTable(null)}>Remove</button>
              </span>
            </div>
          ) : (
            <>
              <span className="ico-wrap"><Icon name="upload" size={20} /></span>
              <span>{busy ? 'Reading…' : <>Drop an <strong>.xlsx</strong>, <strong>.xls</strong> or <strong>.csv</strong> file here, or</>}</span>
              <button type="button" className="btn" onClick={() => input.current?.click()} disabled={busy}>Choose file…</button>
            </>
          )}
          <input ref={input} id={id} type="file" className="visually-hidden" tabIndex={-1} aria-label={`${title} file`}
            accept=".xlsx,.xls,.xlsm,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => void read(e.target.files?.[0])} />
        </div>
        {error ? <div className="banner error" role="alert" style={{ marginTop: 10 }}><Icon name="alert" /> <span>{error}</span></div> : null}
      </div>
    </section>
  );
}

function HowTo() {
  return (
    <section className="card howto" aria-labelledby="howto-h">
      <div className="card-head"><div className="titles"><h2 id="howto-h">How to export from iManage Work</h2><div className="sub">Menu names vary between versions.</div></div></div>
      <div className="card-body small">
        <ol>
          <li>In iManage Work (web), run a document search covering the matters you want to review, for example by client, matter or date range.</li>
          <li>Show the columns you need: Name, Number, Version, Class, Subclass, Author, Created, Edited, Client and Matter (and Workspace if available).</li>
          <li>Select the results (Select all), then choose <strong>Export</strong> (sometimes under <strong>More</strong> or the <strong>…</strong> menu) and save as Excel or CSV.</li>
          <li>Optional: export a matter or workspace list with partner, fee earner, practice area, status, open/close dates and key date.</li>
          <li>Drop the files above. Your own iManage access rights decide what the export contains.</li>
        </ol>
      </div>
    </section>
  );
}

function SettingsTools({ draft, settings }: { draft: Draft; settings: PortalSettings }) {
  const [panel, setPanel] = useState<'copy' | 'paste' | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [msg, setMsg] = useState('');
  async function copy() {
    if (await copyText(serializeSettings(settings))) setMsg('Settings copied. They contain the column and document-type mapping and thresholds only, never any rows.');
    else setPanel('copy');
  }
  function apply() {
    const s = parseSettingsText(pasteText);
    if (!s) return setMsg('That text is not settings copied from this page.');
    portalStore.setSettings(suggestFor(draft, s));
    setPanel(null);
    setPasteText('');
    setMsg('Settings applied.');
  }
  return (
    <section className="card" aria-labelledby="settings-h">
      <div className="card-head"><div className="titles"><h2 id="settings-h">Import settings</h2>
        <div className="sub">The column mapping, document-type mapping and thresholds. This browser remembers them for next time; the imported rows are never stored.</div></div></div>
      <div className="card-body stack-v" style={{ gap: 10 }}>
        <div className="row">
          <button type="button" className="btn small" onClick={() => void copy()}><Icon name="copy" size={14} /> Copy settings</button>
          <button type="button" className="btn small" onClick={() => setPanel(panel === 'paste' ? null : 'paste')} aria-expanded={panel === 'paste'}>Paste settings</button>
          <button type="button" className="btn small ghost" onClick={() => { forgetSettings(); portalStore.setSettings(suggestFor(draft, defaultSettings())); setMsg('Remembered settings forgotten. Defaults restored.'); }}>Reset to defaults</button>
        </div>
        {panel === 'paste' ? (
          <div className="stack-v" style={{ gap: 8 }}>
            <label htmlFor="paste-settings" className="small secondary">Paste settings copied from this page (for example, shared by a colleague), then apply.</label>
            <textarea id="paste-settings" className="copy-area" style={{ minHeight: 110 }} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
            <div className="row"><button type="button" className="btn small primary" onClick={apply}>Apply settings</button></div>
          </div>
        ) : null}
        {msg ? <p className="small secondary" role="status">{msg}</p> : null}
      </div>
      {panel === 'copy' ? <CopyPanel title="Copy settings" text={serializeSettings(settings)} onClose={() => setPanel(null)} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2: columns

function ColumnsStep({ draft, settings, onBack, onNext }: { draft: Draft; settings: PortalSettings; onBack: () => void; onNext: () => void }) {
  const docs = draft.docs!;
  const files = { docs, matters: draft.matters, isSample: draft.isSample };
  const detected = useMemo(() => resolveDayOrder(files, { ...settings, dayOrder: 'auto' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, draft.matters, settings.docColumns.created, settings.docColumns.edited, settings.matterColumns.opened, settings.matterColumns.key_date]);
  const order: DayOrder = settings.dayOrder === 'auto' ? detected : settings.dayOrder;
  const errors = mappingErrors(files, settings);
  const set = (patch: Partial<PortalSettings>) => portalStore.setSettings({ ...settings, ...patch });

  return (
    <>
      <section className="card" aria-labelledby="dates-h">
        <div className="card-head">
          <div className="titles"><h2 id="dates-h">How dates are written</h2>
            <div className="sub">Irish exports normally write dates day first (31/01/2026). Excel date cells and ISO dates are read automatically.</div></div>
          <div className="card-actions">
            <label htmlFor="day-order" className="small secondary">Dates like 03/04/2026 mean</label>
            <select id="day-order" className="select" value={settings.dayOrder} onChange={(e) => set({ dayOrder: e.target.value as PortalSettings['dayOrder'] })}>
              <option value="auto">Detect (found: {detected === 'dmy' ? '3 April' : '4 March'})</option>
              <option value="dmy">3 April (day first)</option>
              <option value="mdy">4 March (month first)</option>
            </select>
          </div>
        </div>
      </section>
      <MappingCard title="Document list" table={docs} fields={DOC_FIELDS} mapping={settings.docColumns} order={order}
        required={['created']} onChange={(m) => set({ docColumns: m })} testId="map-docs"
        preview={['name', 'class', 'subclass', 'created', 'edited', 'client', 'matter', 'workspace']} />
      {draft.matters ? (
        <>
          <MappingCard title="Matter list" table={draft.matters} fields={MATTER_FIELDS} mapping={settings.matterColumns} order={order}
            onChange={(m) => set({ matterColumns: m })} testId="map-matters"
            preview={['client', 'matter', 'matter_name', 'status', 'opened', 'closed', 'key_date']} />
          <section className="card" aria-labelledby="status-h">
            <div className="card-head"><div className="titles"><h2 id="status-h">Matter status</h2>
              <div className="sub">Status values that mean a matter is closed. Any other value counts as open.{!settings.matterColumns.status ? ' No status column is mapped: matters with a close date count as closed.' : ''}</div></div></div>
            <div className="card-body">
              <div className="field" style={{ maxWidth: 420 }}>
                <label htmlFor="closed-values">Closed values (comma-separated, not case-sensitive)</label>
                <ListInput id="closed-values" value={settings.closedValues} onChange={(v) => set({ closedValues: v })} />
              </div>
            </div>
          </section>
        </>
      ) : null}
      {errors.length ? (
        <div className="banner warn" role="alert"><Icon name="alert" /><span className="grow">{errors.map((e) => <div key={e}>{e}</div>)}</span></div>
      ) : null}
      <div className="sticky-actions">
        <button type="button" className="btn" onClick={onBack}><Icon name="back" size={14} /> Back</button>
        <button type="button" className="btn primary" onClick={onNext} disabled={errors.length > 0} data-testid="to-types">Continue to document types</button>
      </div>
    </>
  );
}

function ListInput({ id, value, onChange, placeholder }: { id: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join(', '));
  return (
    <input id={id} className="input" value={text} placeholder={placeholder}
      onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(',').map((x) => x.trim()).filter(Boolean)); }} />
  );
}

function MappingCard<F extends string>({ title, table, fields, mapping, order, required = [], onChange, preview, testId }: {
  title: string; table: RawTable; fields: FieldDef<F>[]; mapping: ColumnMapping<F>; order: DayOrder; required?: F[];
  onChange: (m: ColumnMapping<F>) => void; preview: F[]; testId: string;
}) {
  const idx = (f: F) => (mapping[f] ? table.headers.indexOf(mapping[f]!) : -1);
  const firstValue = (f: F): string | null => {
    const i = idx(f);
    if (i < 0) return null;
    const row = table.rows.find((r) => r[i] !== null);
    return row ? cellText(row[i]) : null;
  };
  const dateStats = useMemo(() => fields.filter((f) => f.date && mapping[f.field]).map((f) => {
    const vals = column(table, mapping[f.field]);
    let filled = 0;
    let bad = 0;
    for (const v of vals) {
      if (v === null) continue;
      filled++;
      if (parseDate(v, order) === null) bad++;
    }
    return { field: f, filled, bad };
  }), [fields, mapping, table, order]);
  const shown = preview.filter((f) => mapping[f]);
  const label = (f: F) => fields.find((x) => x.field === f)!.label;
  const render = (f: F, v: Cell): ReactNode => {
    if (fields.find((x) => x.field === f)?.date) {
      const t = parseDate(v, order);
      return v === null ? <span className="muted">—</span> : t === null ? <span className="warn-ink">Unreadable: {cellText(v)}</span> : fmtParsed(t);
    }
    return cellText(v) ?? <span className="muted">—</span>;
  };
  return (
    <section className="card" aria-labelledby={`${testId}-h`} data-testid={testId}>
      <div className="card-head">
        <div className="titles">
          <h2 id={`${testId}-h`}>{title}: match the columns</h2>
          <div className="sub">{table.fileName} · {table.rows.length.toLocaleString('en-IE')} rows. Suggested from the column names; correct any that are wrong.</div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="data map-table">
          <thead><tr><th>Field</th><th>Column in your file</th><th>First value</th><th>Notes</th></tr></thead>
          <tbody>
            {fields.map((f) => (
              <tr key={f.field}>
                <td><label htmlFor={`${testId}-${f.field}`} style={{ fontWeight: 550 }}>{f.label}</label>{required.includes(f.field) ? <span className="req" title="Required">*</span> : null}</td>
                <td>
                  <select id={`${testId}-${f.field}`} className="select" value={mapping[f.field] ?? ''}
                    onChange={(e) => onChange({ ...mapping, [f.field]: e.target.value || undefined })}>
                    <option value="">— Not in this file —</option>
                    {table.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </td>
                <td><div className="sample" title={firstValue(f.field) ?? undefined}>{firstValue(f.field) ?? '—'}</div></td>
                <td className="small secondary">{f.help ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dateStats.length ? (
        <div className="card-body stat-row" style={{ paddingTop: 12 }} data-testid={`${testId}-date-stats`}>
          {dateStats.map((d) => (
            <span key={d.field.field} className={d.bad ? 'warn-ink' : undefined}>
              {d.field.label}: <strong>{d.bad.toLocaleString('en-IE')}</strong> of {d.filled.toLocaleString('en-IE')} dates could not be read
            </span>
          ))}
        </div>
      ) : null}
      {shown.length ? (
        <>
          <div className="card-body small secondary" style={{ paddingBottom: 6 }}>Preview of the first 5 rows, as they will be read:</div>
          <div className="table-wrap">
            <table className="data" data-testid={`${testId}-preview`}>
              <thead><tr>{shown.map((f) => <th key={f}>{label(f)}</th>)}</tr></thead>
              <tbody>
                {table.rows.slice(0, 5).map((r, i) => (
                  <tr key={i}>{shown.map((f) => <td key={f}>{render(f, r[idx(f)] ?? null)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3: document types and thresholds

function TypesStep({ draft, settings, onBack }: { draft: Draft; settings: PortalSettings; onBack: () => void }) {
  const docs = draft.docs!;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const classes: ClassCount[] = useMemo(() => {
    const ci = settings.docColumns.class ? docs.headers.indexOf(settings.docColumns.class) : -1;
    const si = settings.docColumns.subclass ? docs.headers.indexOf(settings.docColumns.subclass) : -1;
    return distinctClasses(docs.rows.map((r) => ({ cls: ci >= 0 ? cellText(r[ci] ?? null) : null, sub: si >= 0 ? cellText(r[si] ?? null) : null })));
  }, [docs, settings.docColumns.class, settings.docColumns.subclass]);
  // Fill in suggestions for classes not mapped yet (stored, so the user's choices stick).
  const types = useMemo(() => withSuggestions(settings.types, classes), [settings.types, classes]);
  const set = (patch: Partial<PortalSettings>) => portalStore.setSettings({ ...settings, types, ...patch });
  const setTypes = (patch: Partial<PortalSettings['types']>) => set({ types: { ...types, ...patch } });
  const configured = configuredTypes(types, classes);
  const unknown = (Object.keys(CATALOGUE) as ControlId[]).filter((id) => {
    const need: Record<ControlId, string[]> = {
      FO1: ['file_opening'], CF1: ['conflict_clearance'], AML1: ['cdd'], AML2: ['cdd'], EL1: ['engagement_letter', 'engagement_signed', 's150_notice'],
      EL2: types.signedWords.length ? ['engagement_signed', 'engagement_letter'] : ['engagement_signed'], AN1: ['attendance_note'],
      CD1: [], FE1: ['costs_update', 's150_notice'], FE2: ['bill'], HY1: [],
    };
    if (id === 'CD1') return !(draft.matters && settings.matterColumns.key_date);
    return need[id].length > 0 && !need[id].some((t) => configured.has(t));
  });

  function run() {
    setBusy(true);
    setError(null);
    setTimeout(() => {
      try {
        const s = { ...settings, types };
        const ds = buildDataset({ docs, matters: draft.matters, isSample: draft.isSample }, s, nowNaive());
        if (!draft.isSample) {
          saveSettings(s, {
            docs: docs.headerConfident, matters: draft.matters?.headerConfident ?? false,
            classes: Boolean(s.docColumns.class && CLASS_HEADERS.has(normHeader(s.docColumns.class))),
          });
        }
        portalStore.setSettings(s);
        portalStore.setDataset(ds);
        qc.clear();
        navigate('/');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The import could not be completed.');
        setBusy(false);
      }
    }, 0);
  }

  return (
    <>
      <section className="card" aria-labelledby="types-h" data-testid="type-mapping">
        <div className="card-head">
          <div className="titles"><h2 id="types-h">What each document class means</h2>
            <div className="sub">Suggested from the class names; check each one. Intake types (file opening, conflicts, CDD, engagement, s.150) are not substantive work; every other class is.
              A wrong mapping produces false “missing” results.</div></div>
        </div>
        {!settings.docColumns.class ? (
          <div className="card-body"><div className="banner warn"><Icon name="alert" /><span>No Class column is mapped, so only the name rules below can recognise document types.</span></div></div>
        ) : null}
        <div className="table-wrap">
          <table className="data map-table">
            <thead><tr><th>Class / subclass</th><th className="num">Documents</th><th>Treat as</th></tr></thead>
            <tbody>
              {classes.map((c) => (
                <ClassRows key={c.cls || '(blank)'} c={c} types={types} onClass={(k, v) => setTypes({ byClass: { ...types.byClass, [k]: v } })}
                  onSub={(k, v) => setTypes({ byClassSubclass: { ...types.byClassSubclass, [k]: v } })} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="import-grid">
        <section className="card" aria-labelledby="rules-h">
          <div className="card-head"><div className="titles"><h2 id="rules-h">Name rules</h2>
            <div className="sub">For documents whose class is “Other”: if the name contains the text, treat it as the chosen type. Not case-sensitive.</div></div>
            <div className="card-actions"><button type="button" className="btn small" onClick={() => setTypes({ nameRules: [...types.nameRules, { contains: '', type: 'attendance_note' }] })}>Add rule</button></div>
          </div>
          <div className="card-body stack-v" style={{ gap: 8 }}>
            {types.nameRules.length === 0 ? <p className="small secondary">No name rules.</p> : null}
            {types.nameRules.map((r, i) => (
              <NameRuleRow key={i} i={i} rule={r}
                onChange={(nr) => setTypes({ nameRules: types.nameRules.map((x, j) => (j === i ? nr : x)) })}
                onRemove={() => setTypes({ nameRules: types.nameRules.filter((_, j) => j !== i) })} />
            ))}
            <div className="field" style={{ marginTop: 8 }}>
              <label htmlFor="signed-words">Words meaning an engagement letter is signed (EL2)</label>
              <ListInput id="signed-words" value={types.signedWords} onChange={(v) => setTypes({ signedWords: v })} />
            </div>
            {draft.matters ? (
              <div className="field">
                <label htmlFor="aml-exempt">Matter types exempt from AML checks (AML1, AML2)</label>
                <ListInput id="aml-exempt" value={settings.amlExempt} onChange={(v) => set({ amlExempt: v })} placeholder="e.g. INTERNAL" />
              </div>
            ) : null}
          </div>
        </section>
        <section className="card" aria-labelledby="thr-h">
          <div className="card-head"><div className="titles"><h2 id="thr-h">Thresholds</h2><div className="sub">Defaults from the firm's controls catalogue.</div></div></div>
          <div className="card-body threshold-grid">
            {(Object.keys(THRESHOLD_LABELS) as (keyof Thresholds)[]).map((k) => (
              <div className="field" key={k}>
                <label htmlFor={`thr-${k}`}>{THRESHOLD_LABELS[k]}</label>
                <input id={`thr-${k}`} className="input" type="number" min={1} max={3650} step={1} value={settings.thresholds[k]}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1 && n <= 3650) set({ thresholds: { ...settings.thresholds, [k]: n } });
                  }} />
              </div>
            ))}
          </div>
        </section>
      </div>

      {unknown.length ? (
        <div className="banner info" data-testid="unknown-controls"><Icon name="info" />
          <span className="grow">With this mapping, these controls cannot be checked and will show as Unknown: {unknown.map((id) => `${id} (${CATALOGUE[id][0]})`).join('; ')}.</span>
        </div>
      ) : null}
      {error ? <div className="banner error" role="alert"><Icon name="alert" /><span>{error}</span></div> : null}
      <div className="sticky-actions">
        <button type="button" className="btn" onClick={onBack}><Icon name="back" size={14} /> Back</button>
        <button type="button" className="btn primary" onClick={run} disabled={busy} data-testid="run-import">
          {busy ? <><span className="spinner" aria-hidden="true" /> Checking…</> : 'Run the controls and open the dashboard'}
        </button>
      </div>
    </>
  );
}

function TypeSelect({ id, value, onChange, inherit }: { id: string; value: SubclassChoice; onChange: (v: SubclassChoice) => void; inherit?: string }) {
  return (
    <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value as SubclassChoice)}>
      {inherit ? <option value={INHERIT}>Same as class ({inherit})</option> : null}
      {TYPE_CHOICES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
    </select>
  );
}

function ClassRows({ c, types, onClass, onSub }: {
  c: ClassCount; types: PortalSettings['types']; onClass: (k: string, v: TypeChoice) => void; onSub: (k: string, v: SubclassChoice) => void;
}) {
  const k = classKey(c.cls);
  const v = types.byClass[k] ?? suggestType(c.cls);
  const id = `cls-${k.replace(/[^A-Z0-9]/g, '_') || 'blank'}`;
  return (
    <>
      <tr>
        <td><label htmlFor={id}><span className="tag">{c.cls || '(no class)'}</span></label></td>
        <td className="num">{c.count.toLocaleString('en-IE')}</td>
        <td><TypeSelect id={id} value={v} onChange={(x) => onClass(k, x as TypeChoice)} /></td>
      </tr>
      {c.subclasses.map((s) => {
        const ks = classKey(c.cls, s.sub);
        const sid = `${id}-${ks.replace(/[^A-Z0-9]/g, '_')}`;
        return (
          <tr key={ks} className="sub">
            <td><label htmlFor={sid}>{c.cls || '(no class)'} › <span className="tag">{s.sub}</span></label></td>
            <td className="num">{s.count.toLocaleString('en-IE')}</td>
            <td><TypeSelect id={sid} value={types.byClassSubclass[ks] ?? INHERIT} inherit={TYPE_LABEL[v]} onChange={(x) => onSub(ks, x)} /></td>
          </tr>
        );
      })}
    </>
  );
}

function NameRuleRow({ i, rule, onChange, onRemove }: { i: number; rule: NameRule; onChange: (r: NameRule) => void; onRemove: () => void }) {
  return (
    <div className="rule-row">
      <input className="input" aria-label={`Rule ${i + 1}: name contains`} placeholder="Name contains…" value={rule.contains}
        onChange={(e) => onChange({ ...rule, contains: e.target.value })} />
      <select className="select" aria-label={`Rule ${i + 1}: treat as`} value={rule.type} onChange={(e) => onChange({ ...rule, type: e.target.value as NameRule['type'] })}>
        {CANONICAL_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      <button type="button" className="btn small ghost" onClick={onRemove} aria-label={`Remove rule ${i + 1}`}>Remove</button>
    </div>
  );
}
