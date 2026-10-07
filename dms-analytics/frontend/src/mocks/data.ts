/**
 * Deterministic synthetic firm for mock mode and tests.
 * Every name here is obviously fictional. No real client, matter or person data.
 */
import type {
  ControlDef,
  ControlResult,
  ControlStatus,
  EvidenceDoc,
  MatterDetail,
  MatterSummary,
  PersonRef,
  TimelineEvent,
  TrendPoint,
} from '../api/types';

/** Fixed "now" for the synthetic firm so screens and screenshots are stable. */
export const MOCK_NOW = new Date('2026-10-06T21:00:00Z');
const DAY = 86_400_000;

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CONTROLS: ControlDef[] = [
  { id: 'FO1', name: 'File-opening form on file', category: 'file_opening', severity: 2, basis: 'imanage_filing', configured: true,
    description: 'A file-opening form is filed within 5 days of the workspace being created.' },
  { id: 'CF1', name: 'Conflict clearance before work', category: 'conflicts', severity: 3, basis: 'imanage_filing', configured: true,
    description: 'A conflict clearance document is filed on or before the first substantive document.' },
  { id: 'AML1', name: 'CDD before work', category: 'aml', severity: 3, basis: 'imanage_filing', configured: true,
    description: 'A customer due diligence (CDD) document is filed on or before the first substantive document. Exempt matter types are not applicable.' },
  { id: 'AML2', name: 'CDD currency (open matters)', category: 'aml', severity: 2, basis: 'imanage_filing', configured: true,
    description: 'The latest CDD document on an open matter is no older than 36 months.' },
  { id: 'EL1', name: 'Engagement letter / s.150 notice', category: 'engagement', severity: 3, basis: 'imanage_filing', configured: true,
    description: 'An engagement letter or s.150 notice is filed within 14 days of the first substantive document.' },
  { id: 'EL2', name: 'Signed engagement letter returned', category: 'engagement', severity: 2, basis: 'imanage_filing', configured: true,
    description: 'A signed engagement letter is on file.' },
  { id: 'AN1', name: 'Attendance note cadence', category: 'attendance', severity: 1, basis: 'imanage_filing', configured: true,
    description: 'Where an open matter had substantive activity in the last 90 days, at least one attendance note was filed in those 90 days.' },
  { id: 'CD1', name: 'Critical date recorded', category: 'critical_dates', severity: 2, basis: 'imanage_filing', configured: true,
    description: "The workspace's key date field is populated." },
  { id: 'FE1', name: 'Costs update (matters open > 12 months)', category: 'fees', severity: 2, basis: 'imanage_filing', configured: true,
    description: 'For matters open more than 12 months, a costs update or s.150 notice is filed in the last 12 months.' },
  { id: 'FE2', name: 'Billing evidence (active matters)', category: 'fees', severity: 1, basis: 'imanage_filing', configured: true,
    description: 'Where a matter was active in the last 6 months, a bill was filed in the last 6 months.' },
  { id: 'HY1', name: 'Dormant open matter', category: 'hygiene', severity: 1, basis: 'imanage_filing', configured: true,
    description: 'An open matter with no document activity in 12 months is flagged for closure review.' },
];
const SEVERITY = Object.fromEntries(CONTROLS.map((c) => [c.id, c.severity])) as Record<string, number>;

export const PRACTICE_AREAS = ['Banking & Finance', 'Commercial', 'Corporate', 'Employment', 'Litigation', 'Private Client', 'Property'];
export const OFFICES = ['Cork', 'Dublin', 'Limerick'];
const GREEK = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const NUMBERS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen'];
export const PARTNERS: PersonRef[] = GREEK.map((g, i) => ({ id: `p${String(i + 1).padStart(2, '0')}`, name: `Partner ${g}` }));
export const FEE_EARNERS: PersonRef[] = NUMBERS.map((n, i) => ({ id: `f${String(i + 1).padStart(2, '0')}`, name: `Fee Earner ${n}` }));

const CLIENT_WORDS = ['Amber', 'Birch', 'Cobalt', 'Delta', 'Elm', 'Fern', 'Granite', 'Harbour', 'Indigo', 'Juniper', 'Kestrel',
  'Linden', 'Maple', 'Nimbus', 'Oak', 'Pine', 'Quartz', 'Rowan', 'Slate', 'Thistle', 'Umber', 'Vale', 'Willow', 'Yew'];
const CLIENT_SUFFIX = ['Example Ltd', 'Sample Holdings DAC', 'Demo Properties Ltd', 'Example Trust', 'Sample Group plc', 'Demo Partners'];
const MATTER_NAMES: Record<string, string[]> = {
  'Banking & Finance': ['Facility agreement', 'Refinancing', 'Security review', 'Loan restructuring'],
  Commercial: ['Supply agreement', 'Licensing terms', 'Distribution agreement', 'Outsourcing contract'],
  Corporate: ['Share purchase', 'Shareholder agreement', 'Group reorganisation', 'Investment round'],
  Employment: ['Employment dispute', 'Contract review', 'Workplace investigation', 'Redundancy advice'],
  Litigation: ['Contract claim', 'Debt recovery', 'Professional negligence claim', 'Injunction application'],
  'Private Client': ['Estate administration', 'Will review', 'Trust restructuring', 'Enduring power of attorney'],
  Property: ['Lease renewal', 'Site acquisition', 'Commercial letting', 'Title investigation'],
};
const MATTER_TYPES_EXEMPT = new Set(['Will review', 'Contract review']);

export interface MockMatter extends MatterSummary {
  controls: ControlResult[];
  first_substantive_at: string;
  doc_type_counts: { canonical_type: string | null; count: number }[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function doc(id: string, name: string, type: string, at: number): EvidenceDoc {
  return { id, name, canonical_type: type, filed_at: iso(at) };
}

const DOC_NAMES: Record<string, string> = {
  file_opening: 'File opening form',
  conflict_clearance: 'Conflict search clearance',
  cdd: 'CDD pack - ID and address',
  engagement_letter: 'Letter of engagement',
  engagement_signed: 'Letter of engagement - SIGNED',
  attendance_note: 'Attendance note - call with client',
  costs_update: 'Section 150 costs update',
  bill: 'Interim bill',
};

/** Weighted status pick: higher `quality` means fewer failures. */
function pick(r: () => number, quality: number, options: [ControlStatus, number][]): ControlStatus {
  const weights = options.map(([s, w]) => (s === 'pass' ? w * (0.5 + quality) : w * (1.5 - quality)));
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r() * total;
  for (let i = 0; i < options.length; i++) {
    x -= weights[i]!;
    if (x <= 0) return options[i]![0];
  }
  return options[options.length - 1]![0];
}

function buildControls(r: () => number, m: { id: string; quality: number; open: boolean; opened: number;
  firstSub: number; lastActivity: number; exempt: boolean; keyDate: string | null }): ControlResult[] {
  const out: ControlResult[] = [];
  const now = MOCK_NOW.getTime();
  const ageDays = (now - m.opened) / DAY;
  const young = ageDays < 20;
  const activeRecently = now - m.lastActivity < 90 * DAY;
  let n = 0;
  const ev = (type: string, at: number) => doc(`${m.id}.${++n}`, `${DOC_NAMES[type]}.docx`, type, at);

  const push = (control_id: string, status: ControlStatus, explanation: string, extra: Partial<ControlResult> = {}) =>
    out.push({ control_id, status, explanation, basis: 'imanage_filing', evidence: [], due_at: null, evidence_at: null, days_late: null, ...extra });

  // FO1
  {
    const due = m.opened + 5 * DAY;
    const s = young ? pick(r, m.quality, [['pass', 6], ['pending', 3]]) : pick(r, m.quality, [['pass', 8], ['late', 1.2], ['missing', 0.8]]);
    if (s === 'pass') { const at = m.opened + Math.floor(r() * 4) * DAY; push('FO1', s, `Filed ${Math.round((at - m.opened) / DAY)} days after the workspace was created (allowed 5).`, { due_at: iso(due), evidence_at: iso(at), evidence: [ev('file_opening', at)] }); }
    else if (s === 'late') { const late = 2 + Math.floor(r() * 30); const at = due + late * DAY; push('FO1', s, `Filed ${late + 5} days after the workspace was created (allowed 5).`, { due_at: iso(due), evidence_at: iso(at), days_late: late, evidence: [ev('file_opening', at)] }); }
    else if (s === 'missing') push('FO1', s, 'No file-opening form found on file.', { due_at: iso(due) });
    else push('FO1', s, `Not due yet. Due by ${fmtDay(due)}.`, { due_at: iso(due) });
  }
  // CF1, AML1 (before first substantive)
  for (const [id, type, label] of [['CF1', 'conflict_clearance', 'conflict clearance'], ['AML1', 'cdd', 'CDD document']] as const) {
    if (id === 'AML1' && m.exempt) { push(id, 'not_applicable', 'Matter type is exempt from CDD.'); continue; }
    const s = pick(r, m.quality, [['pass', 8], ['late', 1.3], ['missing', 0.9]]);
    if (s === 'pass') { const at = m.firstSub - Math.floor(r() * 5) * DAY; push(id, s, `The ${label} was filed on or before the first substantive document.`, { due_at: iso(m.firstSub), evidence_at: iso(at), evidence: [ev(type, at)] }); }
    else if (s === 'late') { const late = 1 + Math.floor(r() * 40); const at = m.firstSub + late * DAY; push(id, s, `The ${label} was filed ${late} ${late === 1 ? "day" : "days"} after the first substantive document.`, { due_at: iso(m.firstSub), evidence_at: iso(at), days_late: late, evidence: [ev(type, at)] }); }
    else push(id, s, `No ${label} found on file.`, { due_at: iso(m.firstSub) });
  }
  // AML2
  if (!m.open || m.exempt) push('AML2', 'not_applicable', m.exempt ? 'Matter type is exempt from CDD.' : 'Applies to open matters only.');
  else {
    const s = pick(r, m.quality, [['pass', 8], ['stale', 1.4], ['missing', 0.5]]);
    if (s === 'pass') { const at = now - Math.floor(r() * 900) * DAY; push('AML2', s, `Latest CDD filed ${fmtDay(at)} (within 36 months).`, { evidence_at: iso(at), evidence: [ev('cdd', at)] }); }
    else if (s === 'stale') { const at = now - (1100 + Math.floor(r() * 500)) * DAY; push('AML2', s, `Latest CDD filed ${fmtDay(at)}, more than 36 months ago.`, { evidence_at: iso(at), evidence: [ev('cdd', at)] }); }
    else push('AML2', s, 'No CDD document found on file.');
  }
  // EL1
  {
    const due = m.firstSub + 14 * DAY;
    const s = young ? pick(r, m.quality, [['pass', 5], ['pending', 4]]) : pick(r, m.quality, [['pass', 8], ['late', 1.4], ['missing', 0.9]]);
    if (s === 'pass') { const d = Math.floor(r() * 13); const at = m.firstSub + d * DAY; push('EL1', s, `Filed ${d} days after the first substantive document (allowed 14).`, { due_at: iso(due), evidence_at: iso(at), evidence: [ev('engagement_letter', at)] }); }
    else if (s === 'late') { const late = 1 + Math.floor(r() * 45); const at = due + late * DAY; push('EL1', s, `Filed ${late + 14} days after the first substantive document (allowed 14).`, { due_at: iso(due), evidence_at: iso(at), days_late: late, evidence: [ev('engagement_letter', at)] }); }
    else if (s === 'missing') push('EL1', s, 'No engagement letter or s.150 notice found on file.', { due_at: iso(due) });
    else push('EL1', s, `Not due yet. Due by ${fmtDay(due)}.`, { due_at: iso(due) });
  }
  // EL2
  {
    const s = young ? 'pending' : pick(r, m.quality, [['pass', 7], ['missing', 1.8]]);
    if (s === 'pass') { const at = m.firstSub + (10 + Math.floor(r() * 20)) * DAY; push('EL2', s, 'A signed engagement letter is on file.', { evidence_at: iso(at), evidence: [ev('engagement_signed', at)] }); }
    else if (s === 'missing') push('EL2', s, 'No signed engagement letter found. A letter was sent but no signed copy is on file.');
    else push('EL2', s, 'Not due yet. The engagement letter has only just been issued.');
  }
  // AN1
  if (!m.open || !activeRecently) push('AN1', 'not_applicable', m.open ? 'No substantive activity in the last 90 days.' : 'Applies to open matters only.');
  else {
    const s = pick(r, m.quality, [['pass', 6], ['missing', 2]]);
    if (s === 'pass') { const at = now - Math.floor(r() * 80) * DAY; push('AN1', s, `Attendance note filed ${fmtDay(at)}.`, { evidence_at: iso(at), evidence: [ev('attendance_note', at)] }); }
    else push('AN1', s, 'Substantive activity in the last 90 days, but no attendance note filed in that period.');
  }
  // CD1
  if (m.keyDate) push('CD1', 'pass', `Key date recorded: ${fmtDay(Date.parse(m.keyDate))}.`);
  else push('CD1', 'missing', 'The key date field is empty.');
  // FE1
  if (!m.open || ageDays < 365) push('FE1', 'not_applicable', 'Applies to matters open more than 12 months.');
  else {
    const s = pick(r, m.quality, [['pass', 6], ['stale', 1.6], ['missing', 1]]);
    if (s === 'pass') { const at = now - Math.floor(r() * 300) * DAY; push('FE1', s, `Costs update filed ${fmtDay(at)}.`, { evidence_at: iso(at), evidence: [ev('costs_update', at)] }); }
    else if (s === 'stale') { const at = now - (400 + Math.floor(r() * 300)) * DAY; push('FE1', s, `Last costs update filed ${fmtDay(at)}, more than 12 months ago.`, { evidence_at: iso(at), evidence: [ev('costs_update', at)] }); }
    else push('FE1', s, 'No costs update or s.150 notice found on file.');
  }
  // FE2
  if (!m.open || now - m.lastActivity > 180 * DAY) push('FE2', 'not_applicable', 'No activity in the last 6 months.');
  else {
    const s = pick(r, m.quality, [['pass', 7], ['stale', 1.3], ['missing', 0.8]]);
    if (s === 'pass') { const at = now - Math.floor(r() * 150) * DAY; push('FE2', s, `Bill filed ${fmtDay(at)}.`, { evidence_at: iso(at), evidence: [ev('bill', at)] }); }
    else if (s === 'stale') { const at = now - (200 + Math.floor(r() * 200)) * DAY; push('FE2', s, `Last bill filed ${fmtDay(at)}, more than 6 months ago.`, { evidence_at: iso(at), evidence: [ev('bill', at)] }); }
    else push('FE2', s, 'No bill found on file.');
  }
  // HY1
  if (!m.open) push('HY1', 'not_applicable', 'Applies to open matters only.');
  else if (now - m.lastActivity > 365 * DAY) push('HY1', 'stale', `No document activity since ${fmtDay(m.lastActivity)}. Consider closure review.`, { evidence_at: iso(m.lastActivity) });
  else push('HY1', 'pass', `Last document activity ${fmtDay(m.lastActivity)}.`, { evidence_at: iso(m.lastActivity) });

  return out;
}

const FAILING: ControlStatus[] = ['late', 'missing', 'stale'];
const APPLICABLE_FOR_RISK: ControlStatus[] = ['pass', 'late', 'missing', 'stale'];

export function riskScore(results: ControlResult[]): number | null {
  let num = 0;
  let den = 0;
  for (const c of results) {
    if (!APPLICABLE_FOR_RISK.includes(c.status)) continue;
    const s = SEVERITY[c.control_id] ?? 1;
    den += s;
    if (FAILING.includes(c.status)) num += s;
  }
  return den === 0 ? null : Math.round((1000 * num) / den) / 10;
}

/** Split a document total across types so the counts always add up to the total. */
function docTypeCounts(total: number, types: [string | null, number][]) {
  const mapped = types.filter(([t]) => t !== null).map(([t, p]) => ({ canonical_type: t, count: Math.floor(total * p) }));
  const used = mapped.reduce((a, d) => a + d.count, 0);
  return [...mapped, { canonical_type: null, count: total - used }].filter((d) => d.count > 0);
}

export function generateMatters(count = 412, seed = 20261006): MockMatter[] {
  const r = mulberry32(seed);
  const now = MOCK_NOW.getTime();
  const out: MockMatter[] = [];
  const clientCount = 140;
  for (let i = 0; i < count; i++) {
    const clientIdx = Math.floor(r() * clientCount);
    const clientCode = `C${10001 + clientIdx}`;
    const word = CLIENT_WORDS[clientIdx % CLIENT_WORDS.length]!;
    const suffix = CLIENT_SUFFIX[Math.floor(clientIdx / CLIENT_WORDS.length) % CLIENT_SUFFIX.length]!;
    const practice = PRACTICE_AREAS[Math.floor(r() * PRACTICE_AREAS.length)]!;
    const names = MATTER_NAMES[practice]!;
    const matterName = names[Math.floor(r() * names.length)]!;
    const partnerIdx = Math.floor(r() * PARTNERS.length);
    const partner = PARTNERS[partnerIdx]!;
    const feeEarner = FEE_EARNERS[(partnerIdx * 2 + Math.floor(r() * 2)) % FEE_EARNERS.length]!;
    const office = OFFICES[r() < 0.6 ? 1 : r() < 0.5 ? 0 : 2]!;
    // Opened between ~7 years ago and 3 days ago, skewed recent.
    const ageDays = Math.max(3, Math.floor(Math.pow(r(), 1.8) * 2600));
    const opened = now - ageDays * DAY - Math.floor(r() * 8) * 3_600_000;
    const open = ageDays < 400 ? r() < 0.93 : r() < 0.55;
    const firstSub = opened + Math.floor(r() * 10) * DAY;
    const dormant = open && r() < 0.08;
    const lastActivity = dormant
      ? now - (380 + Math.floor(r() * 400)) * DAY
      : Math.min(now - 3_600_000, opened + Math.floor(r() * ageDays) * DAY + DAY);
    const recentLast = r() < 0.7 && !dormant ? now - Math.floor(r() * 60) * DAY : lastActivity;
    // Partner and practice affect quality so the heatmap has visible structure.
    const quality = Math.min(1, Math.max(0, 0.55 + (partnerIdx % 4) * 0.08 - (practice === 'Litigation' ? 0.12 : 0) +
      (practice === 'Corporate' ? 0.08 : 0) + (r() - 0.5) * 0.5));
    const keyDate = open && r() < 0.62 ? isoDate(now + Math.floor(r() * 220 - 20) * DAY) : null;
    const id = `MOCK!ws-${String(i + 1).padStart(4, '0')}`;
    const matterCode = `${clientCode}-${String((i % 9) + 1).padStart(4, '0')}`;
    const controls = buildControls(r, { id, quality, open, opened, firstSub, lastActivity: recentLast, exempt: MATTER_TYPES_EXEMPT.has(matterName), keyDate });
    const docCount = 6 + Math.floor(Math.pow(r(), 2) * 420);
    const types: [string | null, number][] = [
      ['correspondence', 0.34], ['draft', 0.22], ['attendance_note', 0.08], ['bill', 0.04], ['cdd', 0.03],
      ['engagement_letter', 0.02], [null, 0.27],
    ];
    out.push({
      id,
      client_code: clientCode,
      client_name: `${word} ${suffix}`,
      matter_code: matterCode,
      matter_name: matterName,
      practice_area: practice,
      partner,
      fee_earner: feeEarner,
      office,
      status: open ? 'open' : 'closed',
      opened_at: iso(opened),
      last_activity_at: iso(recentLast),
      doc_count: docCount,
      risk_score: riskScore(controls),
      failing_controls: controls.filter((c) => FAILING.includes(c.status)).map((c) => c.control_id),
      key_date: keyDate,
      controls,
      first_substantive_at: iso(firstSub),
      doc_type_counts: docTypeCounts(docCount, types),
    });
  }
  return out;
}

export function toSummary(m: MockMatter): MatterSummary {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { controls, first_substantive_at, doc_type_counts, ...rest } = m;
  return rest;
}

export function toDetail(m: MockMatter): MatterDetail {
  const timeline: TimelineEvent[] = [
    { at: m.opened_at, kind: 'opened', label: 'Workspace created', control_id: null },
    { at: m.first_substantive_at, kind: 'first_substantive', label: 'First substantive document filed', control_id: null },
  ];
  for (const c of m.controls) {
    for (const e of c.evidence ?? []) {
      timeline.push({ at: e.filed_at, kind: 'evidence', label: e.name, control_id: c.control_id });
    }
  }
  if (m.key_date) timeline.push({ at: `${m.key_date}T09:00:00Z`, kind: 'key_date', label: 'Key date', control_id: 'CD1' });
  if (m.last_activity_at) timeline.push({ at: m.last_activity_at, kind: 'last_activity', label: 'Most recent document activity', control_id: null });
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return { ...toSummary(m), controls: m.controls, timeline, doc_type_counts: m.doc_type_counts };
}

/** Weekly readiness snapshots over ~6 months, gently improving. */
export function generateTrend(controlId: string): TrendPoint[] {
  const r = mulberry32(controlId.split('').reduce((a, c) => a + c.charCodeAt(0), 7));
  const base = controlId === 'ALL' ? 71 : 62 + r() * 25;
  const points: TrendPoint[] = [];
  const weeks = 26;
  for (let w = weeks - 1; w >= 0; w--) {
    const t = MOCK_NOW.getTime() - w * 7 * DAY;
    const progress = (weeks - w) / weeks;
    const value = Math.min(99, base + progress * 8 + (r() - 0.5) * 2.4);
    const applicable = controlId === 'ALL' ? 400 + Math.floor((weeks - w) / 2) : 330 + Math.floor(r() * 40);
    points.push({
      taken_at: new Date(t - (t % DAY)).toISOString(),
      applicable,
      passing: Math.round((applicable * value) / 100),
      value: Math.round(value * 10) / 10,
    });
  }
  return points;
}
