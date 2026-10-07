import type { TrendPoint } from '../api/types';

const LOCALE = 'en-IE';

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** "2 hours ago" style, relative to `now`. */
export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const diff = now - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '—';
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} days ago`;
}

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString(LOCALE));

/** Rate 0..1 to "86.6%". */
export function fmtRate(r: number | null | undefined, digits = 0): string {
  if (r === null || r === undefined) return '—';
  return `${(r * 100).toFixed(digits)}%`;
}

/** Percentage value 0..100 to "78.4%". */
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '—';
  return `${v.toFixed(digits)}%`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function trendRangeLabel(points: TrendPoint[]): string {
  if (!points.length) return 'No snapshots yet';
  return `${fmtDate(points[0]!.taken_at)} – ${fmtDate(points[points.length - 1]!.taken_at)}`;
}
