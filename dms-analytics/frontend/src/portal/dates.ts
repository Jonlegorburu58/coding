/**
 * Date parsing for spreadsheet exports. Results are "naive UTC" milliseconds:
 * the wall-clock date and time written in the file, stored as if it were UTC,
 * which is how the controls engine (and the Python backend) treats datetimes.
 * Values with an explicit offset (`Z`, `+01:00`) are converted to UTC first.
 */

export type DayOrder = 'dmy' | 'mdy';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const DAY = 86_400_000;
/** Excel serial 25569 is 1 Jan 1970. */
const EXCEL_EPOCH = 25569;

function make(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number | null {
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null; // e.g. 31/02
  return t;
}

function year(y: string): number {
  const n = Number(y);
  if (y.length <= 2) return n < 70 ? 2000 + n : 1900 + n;
  return n;
}

/** Excel serial date (days since 30 Dec 1899, with Excel's 1900 leap-year quirk). */
export function fromExcelSerial(v: number): number | null {
  if (!Number.isFinite(v) || v < 1 || v >= 109575) return null; // up to 31 Dec 2199
  const days = v >= 61 ? v - EXCEL_EPOCH : v - EXCEL_EPOCH + 1;
  const t = Math.round((days * DAY) / 1000) * 1000;
  const y = new Date(t).getUTCFullYear();
  return y < 1900 ? null : t;
}

const TIME = String.raw`(?:[T\s,]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2})(?:\.\d+)?)?\s*([AaPp]\.?[Mm]\.?)?)?`;
const ISO = new RegExp(String.raw`^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})` + String.raw`(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$`);
const NUMERIC = new RegExp(String.raw`^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})` + TIME + '$');
const DAY_MON = new RegExp(String.raw`^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})(?:st|nd|rd|th)?[\s\-/]+([A-Za-z]{3,9})\.?[\s\-/,]+(\d{2}|\d{4})` + TIME + '$');
const MON_DAY = new RegExp(String.raw`^(?:[A-Za-z]{3,9},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})` + TIME + '$');

function hour12(h: number, ampm: string | undefined): number {
  if (!ampm) return h;
  const pm = ampm[0]!.toLowerCase() === 'p';
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}

function withTime(y: number, mo: number, d: number, m: RegExpExecArray, i: number): number | null {
  const h = m[i] ? hour12(Number(m[i]), m[i + 3]) : 0;
  return make(y, mo, d, h, m[i + 1] ? Number(m[i + 1]) : 0, m[i + 2] ? Number(m[i + 2]) : 0);
}

/**
 * Parse one cell. `order` decides ambiguous numeric dates like 03/04/2026
 * (Irish exports are day-first). Returns null when the value is empty or unreadable.
 */
export function parseDate(v: unknown, order: DayOrder = 'dmy'): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes(), v.getSeconds());
  }
  if (typeof v === 'number') return fromExcelSerial(v);
  const s = String(v).trim();
  if (!s) return null;

  let m = ISO.exec(s);
  if (m) {
    const t = make(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
    if (t === null || !m[7] || m[7] === 'Z') return t;
    const sign = m[7][0] === '-' ? -1 : 1;
    const off = m[7].slice(1).replace(':', '');
    return t - sign * (Number(off.slice(0, 2)) * 60 + Number(off.slice(2, 4))) * 60_000;
  }
  m = NUMERIC.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const [d, mo] = order === 'dmy' ? [a, b] : [b, a];
    return withTime(year(m[3]!), mo, d, m, 4);
  }
  m = DAY_MON.exec(s);
  if (m) {
    const mo = MONTHS[m[2]!.toLowerCase()];
    return mo ? withTime(year(m[3]!), mo, Number(m[1]), m, 4) : null;
  }
  m = MON_DAY.exec(s);
  if (m) {
    const mo = MONTHS[m[1]!.toLowerCase()];
    return mo ? withTime(Number(m[3]), mo, Number(m[2]), m, 4) : null;
  }
  if (/^\d{8}$/.test(s)) return make(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)));
  if (/^\d{4,6}(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (n >= 20000 && n < 80000) return fromExcelSerial(n); // a serial that lost its date format in CSV
  }
  return null;
}

/**
 * Look at numeric dates like 13/04/2026 to tell day-first from month-first.
 * Returns null when the sample never disambiguates (then day-first is assumed).
 */
export function detectDayOrder(values: unknown[]): DayOrder | null {
  let dmy = 0;
  let mdy = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = NUMERIC.exec(v.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    else if (b > 12 && a <= 12) mdy++;
  }
  if (dmy === mdy) return null;
  return dmy > mdy ? 'dmy' : 'mdy';
}

export function toIso(t: number | null): string | null {
  return t === null ? null : `${new Date(t).toISOString().slice(0, 19)}Z`;
}

export function toIsoDate(t: number | null): string | null {
  return t === null ? null : new Date(t).toISOString().slice(0, 10);
}

/** The local wall-clock time now, as naive UTC (comparable with parsed dates). */
export function nowNaive(d = new Date()): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
}
