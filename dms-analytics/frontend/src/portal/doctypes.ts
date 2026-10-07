/**
 * Document-type mapping for imported exports: each document class (and optionally
 * class + subclass) is assigned a canonical type, with name rules as a fallback.
 * This replaces `controls.yaml` `doc_types` for the portal (see D215).
 */
import { CANONICAL_TYPES, type CanonicalType } from './engine';

export type TypeChoice = CanonicalType | 'other';
export const INHERIT = 'inherit';
export type SubclassChoice = TypeChoice | typeof INHERIT;

export interface NameRule {
  /** Plain text, matched case-insensitively anywhere in the document name. */
  contains: string;
  type: CanonicalType;
}

export interface TypeMapping {
  /** Key: normalised class code (see `classKey`). */
  byClass: Record<string, TypeChoice>;
  /** Key: `classKey(class, subclass)`. Overrides the class mapping unless "inherit". */
  byClassSubclass: Record<string, SubclassChoice>;
  nameRules: NameRule[];
  /** Words in an engagement letter's name that mean it is signed (EL2). */
  signedWords: string[];
}

export const TYPE_LABEL: Record<TypeChoice, string> = {
  file_opening: 'File-opening form',
  conflict_clearance: 'Conflict clearance',
  cdd: 'CDD / KYC',
  engagement_letter: 'Engagement letter',
  engagement_signed: 'Signed engagement letter',
  s150_notice: 's.150 notice',
  attendance_note: 'Attendance note',
  costs_update: 'Costs update',
  bill: 'Bill / invoice',
  other: 'Other (substantive work)',
};
export const TYPE_CHOICES: TypeChoice[] = [...CANONICAL_TYPES, 'other'];

/** Intake paperwork: everything else counts as substantive work (ARCHITECTURE §3, D215). */
export const INTAKE_TYPES: ReadonlySet<string> = new Set([
  'file_opening', 'conflict_clearance', 'cdd', 'engagement_letter', 'engagement_signed', 's150_notice',
]);

export const DEFAULT_NAME_RULES: NameRule[] = [{ contains: 'attendance note', type: 'attendance_note' }];
export const DEFAULT_SIGNED_WORDS = ['signed', 'countersigned'];

export function classKey(cls: string | null | undefined, sub?: string | null): string {
  const c = (cls ?? '').trim().toUpperCase();
  return sub === undefined ? c : `${c}|${(sub ?? '').trim().toUpperCase()}`;
}

const norm = (s: string) => ` ${s.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()} `;

const SUGGESTIONS: [RegExp, CanonicalType][] = [
  [/ S ?150 | SECTION ?150 | SEC ?150 /, 's150_notice'],
  [/ (FILE ?)?OPEN(ING)? ?FORM | FILE ?OPEN(ING)? | FILEOPEN | NEW ?MATTER | MATTER ?OPEN(ING)? | FOF /, 'file_opening'],
  [/ CONFLICTS? | CONFLICT ?(CHECK|SEARCH|CLEARANCE)? /, 'conflict_clearance'],
  [/ AML | KYC | CDD | CUSTOMER ?DUE ?DILIGENCE | ANTI ?MONEY | CLIENT ?ID(ENTIFICATION)? /, 'cdd'],
  [/ ATT ?NOTE | ATTNOTE | ATTENDANCE( ?NOTE)? /, 'attendance_note'],
  [/ COSTS? ?(UPDATE|ESTIMATE|LETTER)? | FEE ?ESTIMATE /, 'costs_update'],
  [/ BILLS? | INVOICES? | FEE ?NOTE /, 'bill'],
];
const ENGAGE = / ENGAGE(MENT)?( ?LETTER)? | LOE | TERMS ?OF ?(BUSINESS|ENGAGEMENT) | RETAINER | CLIENT ?CARE /;
const SIGNED = / SIGNED | COUNTERSIGNED | EXECUTED /;

/** Keyword suggestion for a class (and subclass). A suggestion only: the user confirms it. */
export function suggestType(cls: string | null, sub?: string | null): TypeChoice {
  const c = norm(cls ?? '');
  const both = norm(`${cls ?? ''} ${sub ?? ''}`);
  if (ENGAGE.test(both)) return SIGNED.test(both) ? 'engagement_signed' : 'engagement_letter';
  for (const [re, t] of SUGGESTIONS) if (re.test(c)) return t;
  if (sub) for (const [re, t] of SUGGESTIONS) if (re.test(norm(sub))) return t;
  return 'other';
}

export interface ClassCount { cls: string; count: number; subclasses: { sub: string; count: number }[] }

/** Distinct classes (and class + subclass pairs) with document counts, most frequent first. */
export function distinctClasses(rows: { cls: string | null; sub: string | null }[]): ClassCount[] {
  const map = new Map<string, { cls: string; count: number; subs: Map<string, number> }>();
  for (const r of rows) {
    const label = (r.cls ?? '').trim();
    const key = classKey(label);
    const e = map.get(key) ?? { cls: label, count: 0, subs: new Map() };
    e.count += 1;
    const sub = (r.sub ?? '').trim();
    if (sub) e.subs.set(sub.toUpperCase(), (e.subs.get(sub.toUpperCase()) ?? 0) + 1);
    map.set(key, e);
  }
  return [...map.values()]
    .map((e) => ({ cls: e.cls, count: e.count, subclasses: [...e.subs].map(([sub, count]) => ({ sub, count })).sort((a, b) => b.count - a.count || a.sub.localeCompare(b.sub)) }))
    .sort((a, b) => b.count - a.count || a.cls.localeCompare(b.cls));
}

/** Fill in suggestions for any class or class+subclass not yet mapped (keeps the user's existing choices). */
export function withSuggestions(mapping: TypeMapping, classes: ClassCount[]): TypeMapping {
  const byClass = { ...mapping.byClass };
  const byClassSubclass = { ...mapping.byClassSubclass };
  for (const c of classes) {
    const k = classKey(c.cls);
    if (!(k in byClass)) byClass[k] = suggestType(c.cls);
    for (const s of c.subclasses) {
      const ks = classKey(c.cls, s.sub);
      if (!(ks in byClassSubclass)) {
        const sug = suggestType(c.cls, s.sub);
        byClassSubclass[ks] = sug === byClass[k] ? INHERIT : sug;
      }
    }
  }
  return { ...mapping, byClass, byClassSubclass };
}

/** Class + subclass mapping first, then the class mapping; name rules apply only to "other". */
export function classify(mapping: TypeMapping, cls: string | null, sub: string | null, name: string): CanonicalType | null {
  let t: TypeChoice | undefined;
  if (sub && sub.trim()) {
    const s = mapping.byClassSubclass[classKey(cls, sub)];
    if (s && s !== INHERIT) t = s;
  }
  t ??= mapping.byClass[classKey(cls)] ?? 'other';
  if (t !== 'other') return t;
  const lower = (name ?? '').toLowerCase();
  for (const r of mapping.nameRules) {
    const needle = r.contains.trim().toLowerCase();
    if (needle && lower.includes(needle)) return r.type;
  }
  return null;
}

/** Canonical types that the mapping can produce for the classes present (drives "configured"). */
export function configuredTypes(mapping: TypeMapping, classes: ClassCount[]): Set<string> {
  const out = new Set<string>();
  for (const c of classes) {
    const t = mapping.byClass[classKey(c.cls)];
    if (t && t !== 'other') out.add(t);
    for (const s of c.subclasses) {
      const ts = mapping.byClassSubclass[classKey(c.cls, s.sub)];
      if (ts && ts !== INHERIT && ts !== 'other') out.add(ts);
    }
  }
  for (const r of mapping.nameRules) if (r.contains.trim()) out.add(r.type);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-word, case-insensitive patterns from the signed words. */
export function signedPatterns(words: string[]): RegExp[] {
  return words.map((w) => w.trim()).filter(Boolean).map((w) => new RegExp(`\\b${escapeRe(w)}\\b`, 'i'));
}

/** Python pattern with optional leading inline flags, e.g. `(?i)\bsigned\b`, as a JS RegExp. */
export function pyRegex(p: string): RegExp {
  const m = /^\(\?([a-zA-Z]+)\)/.exec(p);
  const flags = m ? (m[1]!.includes('i') ? 'i' : '') : '';
  return new RegExp(m ? p.slice(m[0].length) : p, flags);
}
