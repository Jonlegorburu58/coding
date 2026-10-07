/**
 * Turns an imported export (document list, optional matter list) and the
 * user's mapping into the dataset the dashboard's in-page API serves.
 * Everything happens in memory in this tab.
 */
import type { ControlDef, ControlResult, EvidenceDoc, PersonRef, TimelineEvent, TrendPoint } from '../api/types';
import type { MockMatter } from '../mocks/data';
import type { MockDataset } from '../mocks/dataset';
import type { ColumnMapping, MatterField } from './columns';
import { detectDayOrder, parseDate, toIso, toIsoDate, type DayOrder } from './dates';
import { INTAKE_TYPES, classify, configuredTypes, distinctClasses, signedPatterns } from './doctypes';
import {
  ASSESSED, CATALOGUE, CONTROL_IDS, FAILING, SEVERITY_DEFAULTS, complianceRate, describe, evaluateMatter, isConfigured,
  meanReadiness, riskScore, sortDocs, type ControlId, type DocFacts, type EngineConfig, type MatterFacts,
} from './engine';
import { column, type Cell, type RawTable } from './readFile';
import type { PortalSettings } from './settings';

export const UNASSIGNED = 'Unassigned';
const DAY = 86_400_000;

export interface ImportReport {
  documentFile: string;
  matterFile: string | null;
  isSample: boolean;
  dayOrder: DayOrder;
  documentRows: number;
  documentsUsed: number;
  versionsMerged: number;
  skippedNoCreated: number;
  skippedNoMatter: number;
  editedUnreadable: number;
  matters: number;
  mattersWithoutDocs: number;
  mattersOnlyInDocs: number;
  matterRowsSkipped: number;
  openedFromDocs: boolean;
  keyDateMapped: boolean;
  unknownControls: ControlId[];
  notes: string[];
}

export interface PortalDataset extends MockDataset {
  report: ImportReport;
  importedAt: string;
}

export interface ImportFiles {
  docs: RawTable;
  matters: RawTable | null;
  isSample: boolean;
}

/** Problems that stop the import (shown on the mapping step). */
export function mappingErrors(files: ImportFiles, s: PortalSettings): string[] {
  const errs: string[] = [];
  const d = s.docColumns;
  if (!d.created) errs.push('Map the "Created date" column of the document list: the controls depend on it.');
  if (!(d.matter || d.workspace)) errs.push('Map "Client" and "Matter", or "Workspace", so documents can be grouped into matters.');
  if (files.matters) {
    const m = s.matterColumns;
    if (!m.matter && !m.matter_name) errs.push('Map "Matter" (or "Matter name") in the matter list, so it can be matched to the documents.');
  }
  return errs;
}

// ---------------------------------------------------------------------------
// Cells

export function cellText(c: Cell | undefined): string | null {
  if (c === null || c === undefined) return null;
  if (typeof c === 'number') return Number.isInteger(c) ? String(c) : String(c);
  if (c instanceof Date) return Number.isNaN(c.getTime()) ? null : c.toISOString().slice(0, 10);
  const s = String(c).trim();
  return s === '' ? null : s;
}

/** Client and matter codes: case-insensitive, and leading zeros ignored on numeric codes (Excel drops them). */
export function codeKey(s: string): string {
  const u = s.trim().toUpperCase();
  return /^\d+$/.test(u) ? u.replace(/^0+(?=\d)/, '') : u.replace(/\s+/g, ' ');
}

function indexer<F extends string>(table: RawTable, mapping: ColumnMapping<F>) {
  const idx = {} as Record<F, number>;
  for (const [f, h] of Object.entries(mapping) as [F, string][]) {
    const i = table.headers.indexOf(h);
    if (i >= 0) idx[f] = i;
  }
  return (row: Cell[], f: F): Cell => (idx[f] === undefined ? null : (row[idx[f]] ?? null));
}

export function resolveDayOrder(files: ImportFiles, s: PortalSettings): DayOrder {
  if (s.dayOrder !== 'auto') return s.dayOrder;
  const sample = [
    ...column(files.docs, s.docColumns.created, 5000), ...column(files.docs, s.docColumns.edited, 5000),
    ...(files.matters ? [...column(files.matters, s.matterColumns.opened, 5000), ...column(files.matters, s.matterColumns.key_date, 5000)] : []),
  ];
  return detectDayOrder(sample) ?? 'dmy';
}

// ---------------------------------------------------------------------------
// Build

interface DocRow {
  id: string;
  name: string;
  cls: string | null;
  sub: string | null;
  version: number;
  createdAt: number;
  editedAt: number;
}

interface Group {
  key: string;
  client: string | null;
  matter: string | null;
  workspace: string | null;
  docs: Map<string, DocRow>;
}

interface MatterRow {
  client: string | null;
  clientName: string | null;
  matter: string | null;
  matterName: string | null;
  practiceArea: string | null;
  partner: string | null;
  feeEarner: string | null;
  office: string | null;
  status: string | null;
  opened: number | null;
  closed: number | null;
  matterType: string | null;
  keyDate: number | null;
}

const person = (name: string | null): PersonRef => ({ id: name ?? UNASSIGNED, name: name ?? UNASSIGNED });
const cmp = (a: string, b: string) => a.localeCompare(b, 'en-IE', { sensitivity: 'base', numeric: true });

/** The engine's wording mentions controls.yaml; in the portal the equivalent is the import mapping. */
function portalWording(explanation: string): string {
  return explanation
    .replace('No key-date field is mapped in controls.yaml, so this cannot be checked.',
      'No key-date column is mapped in the import, so this cannot be checked.')
    .replace('This control is not configured in controls.yaml (no document type mapping), so it cannot be checked.',
      'No document class is mapped to the type this control needs, so it cannot be checked.');
}

export function buildDataset(files: ImportFiles, s: PortalSettings, nowNaive: number, importedAt = new Date()): PortalDataset {
  const errs = mappingErrors(files, s);
  if (errs.length) throw new Error(errs[0]);
  const dayOrder = resolveDayOrder(files, s);
  const dget = indexer(files.docs, s.docColumns);

  // 1. Documents, grouped into matters; versions of the same document number are combined.
  const groups = new Map<string, Group>();
  let skippedNoCreated = 0;
  let skippedNoMatter = 0;
  let editedUnreadable = 0;
  let versionsMerged = 0;
  const classRows: { cls: string | null; sub: string | null }[] = [];
  files.docs.rows.forEach((row, i) => {
    const created = parseDate(dget(row, 'created'), dayOrder);
    if (created === null) { skippedNoCreated++; return; }
    const client = cellText(dget(row, 'client'));
    const matter = cellText(dget(row, 'matter'));
    const workspace = cellText(dget(row, 'workspace'));
    let key: string;
    if (s.docColumns.matter && matter) key = `CM|${codeKey(client ?? '')}|${codeKey(matter)}`;
    else if (workspace) key = `WS|${codeKey(workspace)}`;
    else { skippedNoMatter++; return; }
    const editedCell = dget(row, 'edited');
    let edited = s.docColumns.edited ? parseDate(editedCell, dayOrder) : created;
    if (edited === null) {
      if (cellText(editedCell) !== null) editedUnreadable++;
      edited = created;
    }
    const g = groups.get(key) ?? { key, client, matter, workspace, docs: new Map<string, DocRow>() };
    groups.set(key, g);
    const number = cellText(dget(row, 'number'));
    const id = number ?? `row-${i + 2}`;
    const version = Number(cellText(dget(row, 'version')) ?? 1) || 1;
    const doc: DocRow = {
      id, name: cellText(dget(row, 'name')) ?? (number ? `Document ${number}` : 'Untitled document'),
      cls: cellText(dget(row, 'class')), sub: cellText(dget(row, 'subclass')), version, createdAt: created, editedAt: edited,
    };
    const prev = g.docs.get(id);
    if (prev) {
      versionsMerged++;
      const newer = version >= prev.version ? doc : prev;
      g.docs.set(id, { ...newer, createdAt: Math.min(prev.createdAt, created), editedAt: Math.max(prev.editedAt, edited) });
    } else g.docs.set(id, doc);
  });
  for (const g of groups.values()) for (const d of g.docs.values()) classRows.push({ cls: d.cls, sub: d.sub });

  // 2. Optional matter list.
  const matterRows = new Map<string, MatterRow>();
  let matterRowsSkipped = 0;
  if (files.matters) {
    const mget = indexer(files.matters, s.matterColumns);
    for (const row of files.matters.rows) {
      const t = (f: MatterField) => cellText(mget(row, f));
      const date = (f: MatterField) => (s.matterColumns[f] ? parseDate(mget(row, f), dayOrder) : null);
      const r: MatterRow = {
        client: t('client'), clientName: t('client_name'), matter: t('matter'), matterName: t('matter_name'),
        practiceArea: t('practice_area'), partner: t('partner'), feeEarner: t('fee_earner'), office: t('office'),
        status: t('status'), opened: date('opened'), closed: date('closed'), matterType: t('matter_type'), keyDate: date('key_date'),
      };
      const keys: string[] = [];
      if (r.matter) keys.push(`CM|${codeKey(r.client ?? '')}|${codeKey(r.matter)}`);
      if (r.matterName) keys.push(`WS|${codeKey(r.matterName)}`);
      if (!keys.length) { matterRowsSkipped++; continue; }
      for (const k of keys) if (!matterRows.has(k)) matterRows.set(k, r);
    }
  }

  // 3. Matters: every document group, plus listed matters with no documents.
  const items: { group: Group | null; row: MatterRow | null }[] = [];
  const usedRows = new Set<MatterRow>();
  let mattersOnlyInDocs = 0;
  for (const g of groups.values()) {
    const row = matterRows.get(g.key) ?? null;
    if (row) usedRows.add(row);
    else if (files.matters) mattersOnlyInDocs++;
    items.push({ group: g, row });
  }
  let mattersWithoutDocs = 0;
  for (const row of new Set(matterRows.values())) {
    if (usedRows.has(row)) continue;
    if (row.opened === null) { matterRowsSkipped++; continue; }
    mattersWithoutDocs++;
    items.push({ group: null, row });
  }

  // 4. Engine configuration from the mapping.
  const classes = distinctClasses(classRows);
  const keyDateMapped = Boolean(files.matters && s.matterColumns.key_date);
  const cfg: EngineConfig = {
    thresholds: s.thresholds,
    severity: SEVERITY_DEFAULTS,
    configuredTypes: configuredTypes(s.types, classes),
    signedPatterns: signedPatterns(s.types.signedWords),
    amlExempt: new Set(s.amlExempt.map((x) => x.trim().toUpperCase())),
    keyDateMapped,
  };
  const closedValues = new Set(s.closedValues.map((x) => x.trim().toUpperCase()));
  const controls: ControlDef[] = CONTROL_IDS.map((id) => ({
    id, name: CATALOGUE[id][0], category: CATALOGUE[id][1], description: describe(id, s.thresholds),
    severity: cfg.severity[id], basis: 'imanage_filing', configured: isConfigured(id, cfg),
  }));
  const ctlName = Object.fromEntries(controls.map((c) => [c.id, c.name]));

  // 5. Evaluate.
  const built: MockMatter[] = [];
  let documentsUsed = 0;
  let openedFromDocs = false;
  for (const { group, row } of items) {
    const rawDocs = group ? [...group.docs.values()] : [];
    documentsUsed += rawDocs.length;
    const docs: (DocFacts & { cls: string | null })[] = rawDocs.map((d) => {
      const t = classify(s.types, d.cls, d.sub, d.name);
      return { id: d.id, name: d.name, isIntake: t !== null && INTAKE_TYPES.has(t), canonicalType: t, createdAt: d.createdAt, editedAt: d.editedAt, cls: d.cls };
    });
    const ordered = sortDocs(docs);
    const earliest = ordered[0]?.createdAt ?? null;
    let opened = row?.opened ?? null;
    if (opened === null) { opened = earliest; openedFromDocs = true; }
    if (opened === null) continue;
    let status: 'open' | 'closed' = 'open';
    if (row && s.matterColumns.status) status = row.status && closedValues.has(row.status.trim().toUpperCase()) ? 'closed' : 'open';
    else if (row && s.matterColumns.closed && row.closed !== null) status = 'closed';
    const facts: MatterFacts = {
      id: group?.key ?? '', status, matterType: row?.matterType ? row.matterType.trim().toUpperCase() : null, openedAt: opened,
      closedAt: status === 'closed' ? (row?.closed ?? null) : null,
      keyDate: row?.keyDate != null ? Math.floor(row.keyDate / DAY) * DAY : null,
    };
    const outcomes = evaluateMatter(facts, docs, cfg, nowNaive);
    const byId = new Map(docs.map((d) => [d.id, d]));
    const results: ControlResult[] = outcomes.map((o) => ({
      control_id: o.controlId, status: o.status, explanation: portalWording(o.explanation), basis: 'imanage_filing',
      due_at: toIso(o.dueAt), evidence_at: toIso(o.evidenceAt), days_late: o.daysLate,
      evidence: o.evidenceDocIds.flatMap((id): EvidenceDoc[] => {
        const d = byId.get(id);
        return d ? [{ id: d.id, name: d.name, canonical_type: d.canonicalType, filed_at: toIso(d.createdAt)! }] : [];
      }),
    }));
    const firstWork = ordered.find((d) => !d.isIntake) ?? null;
    const lastActivity = docs.length ? Math.max(...docs.map((d) => d.editedAt)) : null;
    const timeline: TimelineEvent[] = [{
      at: toIso(opened)!, kind: 'opened', control_id: null,
      label: row?.opened != null ? 'Matter opened' : 'Earliest document filed (used as the opening date)',
    }];
    for (const o of outcomes) {
      if (o.evidenceDocIds.length && o.evidenceAt !== null)
        timeline.push({ at: toIso(o.evidenceAt)!, kind: 'evidence', label: `${ctlName[o.controlId]}: evidence filed`, control_id: o.controlId });
    }
    if (firstWork) timeline.push({ at: toIso(firstWork.createdAt)!, kind: 'first_substantive', label: 'First substantive document filed', control_id: null });
    if (facts.keyDate !== null) timeline.push({ at: toIso(facts.keyDate)!, kind: 'key_date', label: 'Key date', control_id: 'CD1' });
    if (lastActivity !== null) timeline.push({ at: toIso(lastActivity)!, kind: 'last_activity', label: 'Last document activity', control_id: null });
    timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    const counts = new Map<string | null, number>();
    for (const d of docs) counts.set(d.canonicalType, (counts.get(d.canonicalType) ?? 0) + 1);

    const client = row?.client ?? group?.client ?? null;
    const matter = row?.matter ?? group?.matter ?? null;
    const statuses = Object.fromEntries(outcomes.map((o) => [o.controlId, o.status]));
    built.push({
      id: '',
      client_code: client ?? UNASSIGNED,
      client_name: row?.clientName ?? client ?? UNASSIGNED,
      matter_code: matter ?? group?.workspace ?? row?.matterName ?? UNASSIGNED,
      matter_name: row?.matterName ?? group?.workspace ?? '(no matter name in the export)',
      practice_area: row?.practiceArea ?? UNASSIGNED,
      partner: person(row?.partner ?? null),
      fee_earner: person(row?.feeEarner ?? null),
      office: row?.office ?? UNASSIGNED,
      status,
      opened_at: toIso(opened)!,
      last_activity_at: toIso(lastActivity),
      doc_count: docs.length,
      risk_score: riskScore(statuses, cfg.severity),
      failing_controls: outcomes.filter((o) => FAILING.has(o.status)).map((o) => o.controlId),
      key_date: toIsoDate(facts.keyDate),
      controls: results,
      first_substantive_at: firstWork ? toIso(firstWork.createdAt) : null,
      doc_type_counts: [...counts].map(([canonical_type, count]) => ({ canonical_type, count }))
        .sort((a, b) => b.count - a.count || (a.canonical_type === null ? 1 : b.canonical_type === null ? -1 : a.canonical_type.localeCompare(b.canonical_type))),
      timeline,
    });
  }
  built.sort((a, b) => cmp(a.client_code, b.client_code) || cmp(a.matter_code, b.matter_code) || cmp(a.matter_name, b.matter_name));
  built.forEach((m, i) => { m.id = `M${String(i + 1).padStart(5, '0')}`; });

  // 6. Facets, coverage, trend.
  const uniq = (xs: string[]) => [...new Set(xs)].sort(cmp);
  const people = (xs: PersonRef[]) => uniq(xs.map((p) => p.name)).map((n) => ({ id: n, name: n }));
  const openedDates = built.map((m) => m.opened_at.slice(0, 10)).sort();
  const unknownControls = controls.filter((c) => !c.configured).map((c) => c.id as ControlId);
  const docLabel = files.isSample ? 'the fictional sample export' : files.docs.fileName;
  const notes: string[] = [];
  if (!files.matters) notes.push('No matter list was imported: each matter\'s opening date is its earliest document, every matter is treated as open, and practice area, partner, fee earner and office show as "Unassigned".');
  else if (openedFromDocs) notes.push('Some matters had no open date, so their earliest document was used instead.');
  if (!keyDateMapped) notes.push('No key-date column was mapped, so CD1 (critical date recorded) is Unknown.');
  if (skippedNoCreated) notes.push(`${skippedNoCreated.toLocaleString('en-IE')} document rows were left out because their created date could not be read.`);
  if (skippedNoMatter) notes.push(`${skippedNoMatter.toLocaleString('en-IE')} document rows were left out because they had no matter or workspace.`);
  if (mattersOnlyInDocs) notes.push(`${mattersOnlyInDocs.toLocaleString('en-IE')} matters appear in the document list but not in the matter list; their profile fields show as "Unassigned".`);

  const report: ImportReport = {
    documentFile: files.docs.fileName, matterFile: files.matters?.fileName ?? null, isSample: files.isSample, dayOrder,
    documentRows: files.docs.rows.length, documentsUsed, versionsMerged, skippedNoCreated, skippedNoMatter, editedUnreadable,
    matters: built.length, mattersWithoutDocs, mattersOnlyInDocs, matterRowsSkipped, openedFromDocs, keyDateMapped, unknownControls, notes,
  };

  const takenAt = new Date(Math.floor(nowNaive / DAY) * DAY).toISOString();
  const openMatters = built.filter((m) => m.status === 'open');
  const trend = (controlId: string): TrendPoint[] => {
    if (controlId === 'ALL') {
      let applicable = 0;
      let passing = 0;
      for (const m of openMatters) for (const c of m.controls) if (ASSESSED.has(c.status)) { applicable++; if (c.status === 'pass') passing++; }
      return [{ taken_at: takenAt, applicable, passing, value: meanReadiness(openMatters.map((m) => m.risk_score)) }];
    }
    let applicable = 0;
    let passing = 0;
    for (const m of openMatters) {
      const c = m.controls.find((x) => x.control_id === controlId);
      if (c && ASSESSED.has(c.status)) { applicable++; if (c.status === 'pass') passing++; }
    }
    const rate = complianceRate(passing, applicable);
    return [{ taken_at: takenAt, applicable, passing, value: rate === null ? null : Math.round(rate * 1000) / 10 }];
  };

  return {
    matters: built,
    controls,
    filters: {
      practice_areas: uniq(built.map((m) => m.practice_area ?? UNASSIGNED)),
      partners: people(built.map((m) => m.partner!)),
      fee_earners: people(built.map((m) => m.fee_earner!)),
      offices: uniq(built.map((m) => m.office ?? UNASSIGNED)),
      opened_range: { min: openedDates[0] ?? null, max: openedDates[openedDates.length - 1] ?? null },
    },
    now: new Date(nowNaive),
    coverage: { libraries: 1, workspaces_visible: built.length, documents: documentsUsed },
    coverageNote: `Based on ${built.length.toLocaleString('en-IE')} matters / ${documentsUsed.toLocaleString('en-IE')} documents from ${docLabel}. Held only in this browser tab.`,
    sourceName: docLabel,
    userDisplayName: 'You',
    trend,
    backendScopes: true,
    report,
    importedAt: importedAt.toISOString(),
  };
}
