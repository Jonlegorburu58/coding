/**
 * Controls engine (ARCHITECTURE §3), ported from the Python reference
 * implementation in `dms-analytics/backend/src/dms_analytics/controls/engine.py`
 * and `scoring.py`. Pure functions, no I/O.
 *
 * All datetimes are numbers: milliseconds since the epoch of a *naive* wall-clock
 * time stored as if it were UTC (the backend uses naive UTC datetimes). Dates are
 * compared at calendar-day granularity ("filed on or before" includes the same day).
 * Keep this file in step with the Python engine; `engine.parity.test.ts` checks it.
 */

export const CONTROL_IDS = ['FO1', 'CF1', 'AML1', 'AML2', 'EL1', 'EL2', 'AN1', 'CD1', 'FE1', 'FE2', 'HY1'] as const;
export type ControlId = (typeof CONTROL_IDS)[number];

export const CANONICAL_TYPES = [
  'file_opening', 'conflict_clearance', 'cdd', 'engagement_letter', 'engagement_signed',
  's150_notice', 'attendance_note', 'costs_update', 'bill',
] as const;
export type CanonicalType = (typeof CANONICAL_TYPES)[number];

export const THRESHOLD_DEFAULTS = {
  FO1_days: 5, EL1_days: 14, AML2_months: 36, AN1_days: 90, FE1_months: 12, FE2_months: 6, HY1_months: 12,
};
export type Thresholds = typeof THRESHOLD_DEFAULTS;
export const SEVERITY_DEFAULTS: Record<ControlId, number> = {
  FO1: 2, CF1: 3, AML1: 3, AML2: 2, EL1: 3, EL2: 2, AN1: 1, CD1: 2, FE1: 2, FE2: 1, HY1: 1,
};

export type Status = 'pass' | 'late' | 'missing' | 'stale' | 'pending' | 'not_applicable' | 'unknown';
export const FAILING: ReadonlySet<Status> = new Set(['late', 'missing', 'stale']);
export const ASSESSED: ReadonlySet<Status> = new Set(['pass', 'late', 'missing', 'stale']);
export const BASIS = 'imanage_filing';

const ENGAGEMENT_TYPES: ReadonlySet<string> = new Set(['engagement_letter', 'engagement_signed', 's150_notice']);
const COSTS_TYPES: ReadonlySet<string> = new Set(['costs_update', 's150_notice']);

export interface MatterFacts {
  id: string;
  status: 'open' | 'closed';
  matterType: string | null;
  openedAt: number;
  closedAt: number | null;
  /** Midnight of the key date, or null. */
  keyDate: number | null;
}

export interface DocFacts {
  id: string;
  name: string;
  /** True when the document is intake paperwork, i.e. not "substantive" work. */
  isIntake: boolean;
  canonicalType: string | null;
  createdAt: number;
  editedAt: number;
}

export interface ControlOutcome {
  controlId: ControlId;
  status: Status;
  explanation: string;
  dueAt: number | null;
  evidenceAt: number | null;
  daysLate: number | null;
  evidenceDocIds: string[];
}

export interface EngineConfig {
  thresholds: Thresholds;
  severity: Record<ControlId, number>;
  /** Canonical types that at least one mapping rule produces. */
  configuredTypes: ReadonlySet<string>;
  signedPatterns: RegExp[];
  amlExempt: ReadonlySet<string>;
  keyDateMapped: boolean;
}

const DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Date helpers (naive UTC)

export function dayOf(t: number): number {
  return Math.floor(t / DAY);
}

function daysBetween(later: number, earlier: number): number {
  return dayOf(later) - dayOf(earlier);
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/** Same day-of-month `months` later (clamped to the month's last day), same time of day. */
export function addMonths(t: number, months: number): number {
  const d = new Date(t);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month0));
  const out = new Date(t);
  out.setUTCFullYear(year, month0, day);
  return out.getTime();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Python `strftime("%d %b %Y").lstrip("0")`, e.g. "5 Mar 2026". */
export function fmtDay(t: number): string {
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function plural(n: number, word: string): string {
  return n === 1 ? `${n} ${word}` : `${n} ${word}s`;
}

function first(docs: readonly DocFacts[], types: ReadonlySet<string>): DocFacts | null {
  for (const d of docs) if (d.canonicalType !== null && types.has(d.canonicalType)) return d;
  return null;
}

function latest(docs: readonly DocFacts[], types: ReadonlySet<string>): DocFacts | null {
  let found: DocFacts | null = null;
  for (const d of docs) if (d.canonicalType !== null && types.has(d.canonicalType)) found = d;
  return found;
}

function out(controlId: ControlId, status: Status, explanation: string, dueAt: number | null = null,
  evidenceAt: number | null = null, daysLate: number | null = null, evidenceDocIds: string[] = []): ControlOutcome {
  return { controlId, status, explanation, dueAt, evidenceAt, daysLate, evidenceDocIds };
}

// ---------------------------------------------------------------------------
// Catalogue

export type Category = 'file_opening' | 'conflicts' | 'aml' | 'engagement' | 'attendance' | 'critical_dates' | 'fees' | 'hygiene';
export const CATALOGUE: Record<ControlId, [name: string, category: Category]> = {
  FO1: ['File-opening form on file', 'file_opening'],
  CF1: ['Conflict clearance before work', 'conflicts'],
  AML1: ['CDD before work', 'aml'],
  AML2: ['CDD currency (open matters)', 'aml'],
  EL1: ['Engagement letter / s.150 notice', 'engagement'],
  EL2: ['Signed engagement letter returned', 'engagement'],
  AN1: ['Attendance note cadence (open matters)', 'attendance'],
  CD1: ['Critical date recorded', 'critical_dates'],
  FE1: ['Costs update (matters open > 12 months)', 'fees'],
  FE2: ['Billing evidence (active matters)', 'fees'],
  HY1: ['Dormant open matter', 'hygiene'],
};

export function describe(cid: ControlId, t: Thresholds): string {
  return {
    FO1: `A file-opening form is filed within ${t.FO1_days} days of the workspace being opened.`,
    CF1: 'A conflict clearance is filed on or before the first substantive document.',
    AML1: 'Customer due diligence (CDD) is filed on or before the first substantive document. Exempt matter types are not applicable.',
    AML2: `On open matters, the latest CDD document is no older than ${t.AML2_months} months.`,
    EL1: `An engagement letter or s.150 notice is filed within ${t.EL1_days} days of the first substantive document.`,
    EL2: 'A signed engagement letter is on file (signed class, or an engagement document whose name indicates it is signed).',
    AN1: `If an open matter had substantive activity in the last ${t.AN1_days} days, at least one attendance note was filed in that period.`,
    CD1: "The workspace's critical (key) date field is populated.",
    FE1: `On matters open more than 12 months, a costs update or s.150 notice was filed in the last ${t.FE1_months} months.`,
    FE2: `If the matter was active in the last ${t.FE2_months} months, a bill was filed in the last ${t.FE2_months} months.`,
    HY1: `An open matter with no document activity in ${t.HY1_months} months is flagged for closure review.`,
  }[cid];
}

export function isConfigured(cid: ControlId, cfg: EngineConfig): boolean {
  const types = cfg.configuredTypes;
  const any = (s: ReadonlySet<string>) => [...s].some((x) => types.has(x));
  switch (cid) {
    case 'FO1': return types.has('file_opening');
    case 'CF1': return types.has('conflict_clearance');
    case 'AML1':
    case 'AML2': return types.has('cdd');
    case 'EL1': return any(ENGAGEMENT_TYPES);
    case 'EL2': return types.has('engagement_signed') || (types.has('engagement_letter') && cfg.signedPatterns.length > 0);
    case 'AN1': return types.has('attendance_note');
    case 'CD1': return cfg.keyDateMapped;
    case 'FE1': return any(COSTS_TYPES);
    case 'FE2': return types.has('bill');
    case 'HY1': return true;
  }
}

// ---------------------------------------------------------------------------
// Individual controls

type Evaluator = (m: MatterFacts, docs: readonly DocFacts[], cfg: EngineConfig, now: number) => ControlOutcome;

const fo1: Evaluator = (m, docs, cfg, now) => {
  const n = cfg.thresholds.FO1_days;
  const due = m.openedAt + n * DAY;
  const ev = first(docs, new Set(['file_opening']));
  if (ev) {
    const after = Math.max(0, daysBetween(ev.createdAt, m.openedAt));
    if (dayOf(ev.createdAt) <= dayOf(due))
      return out('FO1', 'pass', `File-opening form filed ${plural(after, 'day')} after the workspace was opened (allowed ${n}).`,
        due, ev.createdAt, null, [ev.id]);
    const late = daysBetween(ev.createdAt, due);
    return out('FO1', 'late', `File-opening form filed ${plural(after, 'day')} after the workspace was opened, ${plural(late, 'day')} late (allowed ${n}).`,
      due, ev.createdAt, late, [ev.id]);
  }
  if (dayOf(now) <= dayOf(due))
    return out('FO1', 'pending', `Not due yet: a file-opening form is due by ${fmtDay(due)}.`, due);
  return out('FO1', 'missing', `No file-opening form on file. It was due by ${fmtDay(due)}.`, due, null, daysBetween(now, due));
};

function firstWork(docs: readonly DocFacts[]): DocFacts | null {
  return docs.find((d) => !d.isIntake) ?? null;
}

function beforeFirstWork(cid: ControlId, label: string, ctype: string, docs: readonly DocFacts[], now: number): ControlOutcome {
  const fw = firstWork(docs);
  const ev = first(docs, new Set([ctype]));
  const due = fw ? fw.createdAt : null;
  if (ev && (fw === null || dayOf(ev.createdAt) <= dayOf(fw.createdAt))) {
    const expl = fw === null
      ? `${label} filed on ${fmtDay(ev.createdAt)}, before any substantive work.`
      : `${label} filed on ${fmtDay(ev.createdAt)}, on or before the first substantive document (${fmtDay(fw.createdAt)}).`;
    return out(cid, 'pass', expl, due, ev.createdAt, null, [ev.id]);
  }
  if (ev && fw) {
    const late = daysBetween(ev.createdAt, fw.createdAt);
    return out(cid, 'late', `${label} filed ${plural(late, 'day')} after the first substantive document (${fmtDay(fw.createdAt)}).`,
      due, ev.createdAt, late, [ev.id]);
  }
  if (fw === null)
    return out(cid, 'pending', `No substantive work filed yet. ${label} is due before the first substantive document.`);
  return out(cid, 'missing', `No ${label.toLowerCase()} on file, although substantive work started on ${fmtDay(fw.createdAt)}.`,
    due, null, daysBetween(now, fw.createdAt));
}

const isExempt = (m: MatterFacts, cfg: EngineConfig) => m.matterType !== null && cfg.amlExempt.has(m.matterType);

const aml1: Evaluator = (m, docs, cfg, now) => {
  if (isExempt(m, cfg)) return out('AML1', 'not_applicable', 'Matter type is exempt from AML checks.');
  return beforeFirstWork('AML1', 'CDD', 'cdd', docs, now);
};

const aml2: Evaluator = (m, docs, cfg, now) => {
  if (m.status !== 'open') return out('AML2', 'not_applicable', 'Matter is closed.');
  if (isExempt(m, cfg)) return out('AML2', 'not_applicable', 'Matter type is exempt from AML checks.');
  const months = cfg.thresholds.AML2_months;
  const l = latest(docs, new Set(['cdd']));
  if (!l) return out('AML2', 'missing', 'No CDD document on file for this open matter.');
  const due = addMonths(l.createdAt, months);
  if (dayOf(now) > dayOf(due))
    return out('AML2', 'stale', `Latest CDD was filed on ${fmtDay(l.createdAt)}, more than ${months} months ago; it should have been refreshed by ${fmtDay(due)}.`,
      due, l.createdAt, daysBetween(now, due), [l.id]);
  return out('AML2', 'pass', `Latest CDD filed on ${fmtDay(l.createdAt)} (within ${months} months).`, due, l.createdAt, null, [l.id]);
};

function elDue(docs: readonly DocFacts[], cfg: EngineConfig): [DocFacts | null, number | null] {
  const fw = firstWork(docs);
  if (!fw) return [null, null];
  return [fw, fw.createdAt + cfg.thresholds.EL1_days * DAY];
}

const el1: Evaluator = (_m, docs, cfg, now) => {
  const n = cfg.thresholds.EL1_days;
  const [fw, due] = elDue(docs, cfg);
  const ev = first(docs, ENGAGEMENT_TYPES);
  if (ev && (due === null || dayOf(ev.createdAt) <= dayOf(due))) {
    let expl: string;
    if (fw === null) expl = `Engagement letter / s.150 notice filed on ${fmtDay(ev.createdAt)}.`;
    else {
      const delta = daysBetween(ev.createdAt, fw.createdAt);
      expl = delta <= 0
        ? 'Engagement letter / s.150 notice filed before the first substantive document.'
        : `Engagement letter / s.150 notice filed ${plural(delta, 'day')} after the first substantive document (allowed ${n}).`;
    }
    return out('EL1', 'pass', expl, due, ev.createdAt, null, [ev.id]);
  }
  if (ev && due !== null && fw) {
    const late = daysBetween(ev.createdAt, due);
    const delta = daysBetween(ev.createdAt, fw.createdAt);
    return out('EL1', 'late', `Engagement letter / s.150 notice filed ${plural(delta, 'day')} after the first substantive document (allowed ${n}).`,
      due, ev.createdAt, late, [ev.id]);
  }
  if (due === null)
    return out('EL1', 'pending', `No substantive work filed yet. An engagement letter or s.150 notice is due within ${n} days of it.`);
  if (dayOf(now) <= dayOf(due))
    return out('EL1', 'pending', `Not due yet: an engagement letter or s.150 notice is due by ${fmtDay(due)}.`, due);
  return out('EL1', 'missing', `No engagement letter or s.150 notice on file. It was due by ${fmtDay(due)}.`, due, null, daysBetween(now, due));
};

export function nameLooksSigned(name: string, cfg: EngineConfig): boolean {
  return cfg.signedPatterns.some((p) => { p.lastIndex = 0; return p.test(name || ''); });
}

const el2: Evaluator = (_m, docs, cfg, now) => {
  const signed = docs.find((d) => d.canonicalType === 'engagement_signed'
    || (d.canonicalType === 'engagement_letter' && nameLooksSigned(d.name, cfg))) ?? null;
  const [, due] = elDue(docs, cfg);
  if (signed)
    return out('EL2', 'pass', `Signed engagement letter on file (filed ${fmtDay(signed.createdAt)}).`, due, signed.createdAt, null, [signed.id]);
  if (due === null || dayOf(now) <= dayOf(due))
    return out('EL2', 'pending', 'Not due yet: the signed engagement letter is expected once the engagement letter deadline has passed.', due);
  return out('EL2', 'missing', 'No signed engagement letter on file.', due, null, daysBetween(now, due));
};

const an1: Evaluator = (m, docs, cfg, now) => {
  if (m.status !== 'open') return out('AN1', 'not_applicable', 'Matter is closed.');
  const n = cfg.thresholds.AN1_days;
  const start = now - n * DAY;
  const active = docs.some((d) => !d.isIntake && d.editedAt >= start);
  if (!active) return out('AN1', 'not_applicable', `No substantive activity in the last ${n} days.`);
  const notes = docs.filter((d) => d.canonicalType === 'attendance_note' && d.createdAt >= start);
  if (notes.length) {
    const last = notes[notes.length - 1]!;
    return out('AN1', 'pass', `${plural(notes.length, 'attendance note')} filed in the last ${n} days.`, null, last.createdAt, null,
      notes.map((d) => d.id).slice(-5));
  }
  return out('AN1', 'missing', `The matter was active in the last ${n} days but no attendance note was filed in that period.`);
};

const cd1: Evaluator = (m, _docs, cfg) => {
  if (!cfg.keyDateMapped)
    return out('CD1', 'unknown', 'No key-date field is mapped in controls.yaml, so this cannot be checked.');
  if (m.keyDate !== null) return out('CD1', 'pass', `Key date recorded: ${fmtDay(m.keyDate)}.`);
  return out('CD1', 'missing', 'No key date recorded on the workspace.');
};

const fe1: Evaluator = (m, docs, cfg, now) => {
  if (m.status !== 'open') return out('FE1', 'not_applicable', 'Matter is closed.');
  if (m.openedAt > addMonths(now, -12)) return out('FE1', 'not_applicable', 'Matter has been open for less than 12 months.');
  const months = cfg.thresholds.FE1_months;
  const l = latest(docs, COSTS_TYPES);
  if (!l) return out('FE1', 'missing', 'No costs update or s.150 notice on file for a matter open more than 12 months.');
  const due = addMonths(l.createdAt, months);
  if (dayOf(now) > dayOf(due))
    return out('FE1', 'stale', `Latest costs update was filed on ${fmtDay(l.createdAt)}, more than ${months} months ago.`,
      due, l.createdAt, daysBetween(now, due), [l.id]);
  return out('FE1', 'pass', `Costs update filed on ${fmtDay(l.createdAt)} (within ${months} months).`, due, l.createdAt, null, [l.id]);
};

const fe2: Evaluator = (_m, docs, cfg, now) => {
  const months = cfg.thresholds.FE2_months;
  const start = addMonths(now, -months);
  if (!docs.some((d) => d.editedAt >= start)) return out('FE2', 'not_applicable', `No activity in the last ${months} months.`);
  const l = latest(docs, new Set(['bill']));
  if (!l) return out('FE2', 'missing', `The matter was active in the last ${months} months but no bill is on file.`);
  const due = addMonths(l.createdAt, months);
  if (l.createdAt < start)
    return out('FE2', 'stale', `The matter was active in the last ${months} months but the latest bill was filed on ${fmtDay(l.createdAt)}.`,
      due, l.createdAt, daysBetween(now, due), [l.id]);
  return out('FE2', 'pass', `Bill filed on ${fmtDay(l.createdAt)} (within ${months} months).`, due, l.createdAt, null, [l.id]);
};

const hy1: Evaluator = (m, docs, cfg, now) => {
  if (m.status !== 'open') return out('HY1', 'not_applicable', 'Matter is closed.');
  const months = cfg.thresholds.HY1_months;
  const last = docs.length ? Math.max(...docs.map((d) => d.editedAt)) : m.openedAt;
  const due = addMonths(last, months);
  if (dayOf(now) > dayOf(due))
    return out('HY1', 'stale', `No document activity since ${fmtDay(last)} (more than ${months} months). Review for closure.`,
      due, last, daysBetween(now, due));
  return out('HY1', 'pass', `Last document activity on ${fmtDay(last)}.`, null, last);
};

const EVALUATORS: Record<ControlId, Evaluator> = {
  FO1: fo1,
  CF1: (_m, d, _c, n) => beforeFirstWork('CF1', 'Conflict clearance', 'conflict_clearance', d, n),
  AML1: aml1, AML2: aml2, EL1: el1, EL2: el2, AN1: an1, CD1: cd1, FE1: fe1, FE2: fe2, HY1: hy1,
};

const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Documents in engine order: created date, then id. */
export function sortDocs<T extends { createdAt: number; id: string }>(docs: readonly T[]): T[] {
  return [...docs].sort((a, b) => a.createdAt - b.createdAt || cmpStr(a.id, b.id));
}

/** Evaluate every control for one matter. `docs` need not be sorted. */
export function evaluateMatter(m: MatterFacts, docs: readonly DocFacts[], cfg: EngineConfig, now: number): ControlOutcome[] {
  const ordered = sortDocs(docs);
  return CONTROL_IDS.map((cid) =>
    isConfigured(cid, cfg)
      ? EVALUATORS[cid](m, ordered, cfg, now)
      : out(cid, 'unknown', 'This control is not configured in controls.yaml (no document type mapping), so it cannot be checked.'),
  );
}

// ---------------------------------------------------------------------------
// Scoring (scoring.py)

/**
 * Python's `round(x, nd)`: correctly rounded, ties to even, on the exact binary value.
 * (`Math.round` rounds ties up, which would differ from the backend on values like 6.25.)
 */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(nd + 40); // exact decimal expansion, well past the double's precision
  const [ip = '0', fp = ''] = s.split('.');
  const keep = fp.slice(0, nd);
  const rest = fp.slice(nd);
  const digits = ip + keep;
  let n = BigInt(digits);
  const firstRest = rest.charCodeAt(0) - 48;
  const tail = rest.slice(1);
  const tieOrAbove = firstRest > 5 || (firstRest === 5 && /[1-9]/.test(tail));
  const exactTie = firstRest === 5 && !/[1-9]/.test(tail);
  if (tieOrAbove || (exactTie && n % 2n === 1n)) n += 1n;
  const v = Number(n) / 10 ** nd;
  return neg ? -v : v;
}

export function riskScore(statuses: Partial<Record<ControlId, Status>>, severity: Record<ControlId, number>): number | null {
  let applicable = 0;
  let failing = 0;
  for (const [cid, status] of Object.entries(statuses) as [ControlId, Status][]) {
    if (!ASSESSED.has(status)) continue;
    const sev = severity[cid] ?? 1;
    applicable += sev;
    if (FAILING.has(status)) failing += sev;
  }
  if (applicable === 0) return null;
  return pyRound((100 * failing) / applicable, 1);
}

export function meanReadiness(scores: (number | null)[]): number | null {
  const values = scores.filter((s): s is number => s !== null).map((s) => 100 - s);
  if (!values.length) return null;
  return pyRound(values.reduce((a, b) => a + b, 0) / values.length, 1);
}

export function complianceRate(pass: number, assessed: number): number | null {
  return assessed === 0 ? null : pyRound(pass / assessed, 3);
}
