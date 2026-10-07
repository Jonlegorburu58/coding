/**
 * Portal settings: column mapping, document-type mapping and thresholds.
 * These describe the *shape* of an export, never its rows. They may be
 * remembered in this browser and copied or pasted as JSON.
 * Row data is never stored (D217).
 */
import { DOC_FIELDS, MATTER_FIELDS, type ColumnMapping, type DocField, type MatterField } from './columns';
import type { DayOrder } from './dates';
import { DEFAULT_NAME_RULES, DEFAULT_SIGNED_WORDS, INHERIT, TYPE_CHOICES, type TypeMapping } from './doctypes';
import { CANONICAL_TYPES, THRESHOLD_DEFAULTS, type Thresholds } from './engine';

export interface PortalSettings {
  version: 1;
  docColumns: ColumnMapping<DocField>;
  matterColumns: ColumnMapping<MatterField>;
  dayOrder: DayOrder | 'auto';
  types: TypeMapping;
  thresholds: Thresholds;
  /** Status values that mean closed (case-insensitive). Anything else counts as open. */
  closedValues: string[];
  /** Matter types for which AML1/AML2 are not applicable. */
  amlExempt: string[];
}

export function defaultSettings(): PortalSettings {
  return {
    version: 1,
    docColumns: {},
    matterColumns: {},
    dayOrder: 'auto',
    types: { byClass: {}, byClassSubclass: {}, nameRules: DEFAULT_NAME_RULES.map((r) => ({ ...r })), signedWords: [...DEFAULT_SIGNED_WORDS] },
    thresholds: { ...THRESHOLD_DEFAULTS },
    closedValues: ['CLOSED'],
    amlExempt: [],
  };
}

export const THRESHOLD_LABELS: Record<keyof Thresholds, string> = {
  FO1_days: 'FO1: file-opening form due within (days of opening)',
  EL1_days: 'EL1: engagement letter due within (days of first substantive document)',
  AML2_months: 'AML2: CDD must be no older than (months)',
  AN1_days: 'AN1: attendance-note window (days)',
  FE1_months: 'FE1: costs update within (months)',
  FE2_months: 'FE2: bill within (months)',
  HY1_months: 'HY1: dormant after (months without activity)',
};

const STORAGE_KEY = 'bws-dms-portal-settings-v1';
const MAX_STR = 120;

const str = (v: unknown): string | null => (typeof v === 'string' && v.length <= MAX_STR ? v : null);
const strList = (v: unknown, max = 50): string[] =>
  Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null && x.trim() !== '').slice(0, max) : [];

function columns<F extends string>(v: unknown, fields: readonly { field: F }[]): ColumnMapping<F> {
  const out: ColumnMapping<F> = {};
  if (!v || typeof v !== 'object') return out;
  for (const { field } of fields) {
    const h = str((v as Record<string, unknown>)[field]);
    if (h) out[field] = h;
  }
  return out;
}

function record<T extends string>(v: unknown, allowed: readonly T[], max = 500): Record<string, T> {
  const out: Record<string, T> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, max)) {
    if (k.length <= MAX_STR * 2 + 1 && typeof val === 'string' && (allowed as readonly string[]).includes(val)) out[k] = val as T;
  }
  return out;
}

/** Validate untrusted settings JSON (from storage or the clipboard), keeping only known, well-formed fields. */
export function sanitizeSettings(v: unknown): PortalSettings {
  const d = defaultSettings();
  if (!v || typeof v !== 'object') return d;
  const o = v as Record<string, unknown>;
  const t = (o.types ?? {}) as Record<string, unknown>;
  const thresholds = { ...d.thresholds };
  const th = (o.thresholds ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(thresholds) as (keyof Thresholds)[]) {
    const n = th[k];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 3650) thresholds[k] = n;
  }
  const nameRules = Array.isArray(t.nameRules)
    ? t.nameRules.flatMap((r: unknown) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        const contains = str(rr.contains);
        const type = rr.type;
        return contains && typeof type === 'string' && (CANONICAL_TYPES as readonly string[]).includes(type)
          ? [{ contains, type: type as (typeof CANONICAL_TYPES)[number] }] : [];
      }).slice(0, 50)
    : d.types.nameRules;
  return {
    version: 1,
    docColumns: columns(o.docColumns, DOC_FIELDS),
    matterColumns: columns(o.matterColumns, MATTER_FIELDS),
    dayOrder: o.dayOrder === 'dmy' || o.dayOrder === 'mdy' ? o.dayOrder : 'auto',
    types: {
      byClass: record(t.byClass, TYPE_CHOICES),
      byClassSubclass: record(t.byClassSubclass, [...TYPE_CHOICES, INHERIT]),
      nameRules,
      signedWords: Array.isArray(t.signedWords) ? strList(t.signedWords) : d.types.signedWords,
    },
    thresholds,
    closedValues: Array.isArray(o.closedValues) ? strList(o.closedValues) : d.closedValues,
    amlExempt: strList(o.amlExempt),
  };
}

export function serializeSettings(s: PortalSettings): string {
  return JSON.stringify({ app: 'bws-dms-portal-settings', ...s }, null, 2);
}

export function parseSettingsText(text: string): PortalSettings | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    if (!v || typeof v !== 'object' || v.app !== 'bws-dms-portal-settings') return null;
    return sanitizeSettings(v);
  } catch {
    return null;
  }
}

/**
 * Browser storage for settings only. Any failure (private window, blocked
 * storage, sandboxed frame) is ignored: the page works without it.
 */
function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadSettings(): PortalSettings {
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

/**
 * Remember settings. As a guard against storing row values by mistake, column
 * names are kept only when the header row was recognised, and class mappings
 * only when the mapped Class column has a recognised class header (`safe`).
 */
export function saveSettings(s: PortalSettings, safe: { docs: boolean; matters: boolean; classes: boolean }) {
  const keep: PortalSettings = {
    ...s,
    docColumns: safe.docs ? s.docColumns : {},
    matterColumns: safe.matters ? s.matterColumns : {},
    types: safe.classes ? s.types : { ...s.types, byClass: {}, byClassSubclass: {} },
  };
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(keep)));
  } catch {
    /* storage unavailable: nothing to do */
  }
}

export function forgetSettings() {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
