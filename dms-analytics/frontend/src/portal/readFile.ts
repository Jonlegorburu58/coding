/**
 * Reads an exported spreadsheet (.xlsx, .xls or .csv) into a plain table, in
 * memory, in this tab. Uses SheetJS 0.20.x from the official SheetJS tarball
 * (not the outdated npm `xlsx@0.18`). Formulas are never evaluated and no
 * cell is ever rendered as HTML.
 */
import { read, utils, type WorkBook } from 'xlsx';
import { DOC_FIELDS, MATTER_FIELDS, normHeader } from './columns';

export type Cell = string | number | boolean | Date | null;

export interface RawTable {
  fileName: string;
  sheetName: string | null;
  headers: string[];
  rows: Cell[][];
  /** The header row matched known iManage column names, so it is safe to remember the mapping. */
  headerConfident: boolean;
}

export const MAX_FILE_BYTES = 60 * 1024 * 1024;
export const MAX_ROWS = 300_000;

export class ImportError extends Error {}

const KNOWN = new Set([...DOC_FIELDS, ...MATTER_FIELDS].flatMap((f) => f.synonyms.map(normHeader)));

function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    // Older Excel "CSV" files on Windows are Windows-1252.
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function isTextFile(name: string): boolean {
  return /\.(csv|txt|tsv)$/i.test(name);
}

function workbook(buf: ArrayBuffer, fileName: string): WorkBook {
  const common = { cellFormula: false, cellHTML: false, cellNF: false, cellStyles: false, sheetStubs: false, bookVBA: false } as const;
  if (isTextFile(fileName)) {
    // raw: keep every value as text, so dates are parsed by our own day-first-aware parser.
    return read(decodeText(buf), { ...common, type: 'string', raw: true, dense: true });
  }
  return read(new Uint8Array(buf), { ...common, type: 'array', cellDates: false, dense: true });
}

function cellOut(v: unknown): Cell {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' ? null : s;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  return String(v);
}

/** Pick the header row among the first 15: the one naming the most known columns. */
function findHeader(rows: unknown[][]): { index: number; confident: boolean } {
  let best = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const r = rows[i] ?? [];
    const score = r.filter((c) => typeof c === 'string' && KNOWN.has(normHeader(c))).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (bestScore <= 0) {
    // No known names: use the first row with at least two text cells.
    const i = rows.findIndex((r) => (r ?? []).filter((c) => typeof c === 'string' && c.trim()).length >= 2);
    return { index: Math.max(0, i), confident: false };
  }
  return { index: best, confident: bestScore >= 2 };
}

function uniqueHeaders(raw: unknown[], width: number): string[] {
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    let h = raw[i] === null || raw[i] === undefined ? '' : String(raw[i]).trim().replace(/\s+/g, ' ');
    if (!h) h = `Column ${i + 1}`;
    if (h.length > 80) h = `${h.slice(0, 77)}...`;
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    out.push(n > 1 ? `${h} (${n})` : h);
  }
  return out;
}

export function parseTable(buf: ArrayBuffer, fileName: string): RawTable {
  if (buf.byteLength === 0) throw new ImportError('The file is empty.');
  if (buf.byteLength > MAX_FILE_BYTES) throw new ImportError('The file is larger than 60 MB. Export fewer columns or split the search.');
  let wb: WorkBook;
  try {
    wb = workbook(buf, fileName);
  } catch {
    throw new ImportError('This file could not be read as a spreadsheet. Export it again as .xlsx or .csv.');
  }
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;
    const all = utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false });
    if (all.length < 2) continue;
    const { index, confident } = findHeader(all);
    const body = all.slice(index + 1);
    if (body.length > MAX_ROWS) throw new ImportError(`The file has more than ${MAX_ROWS.toLocaleString('en-IE')} rows. Split the search into smaller exports.`);
    const width = Math.max(...all.slice(index, index + 200).map((r) => r.length));
    const headers = uniqueHeaders(all[index] ?? [], width);
    const rows = body
      .map((r) => headers.map((_, i) => cellOut(r[i])))
      .filter((r) => r.some((c) => c !== null));
    if (!rows.length) continue;
    return { fileName, sheetName: isTextFile(fileName) ? null : sheetName, headers, rows, headerConfident: confident };
  }
  throw new ImportError('No rows were found in this file. Check that the export contains the search results.');
}

export async function readTableFile(file: File): Promise<RawTable> {
  if (!/\.(xlsx|xlsm|xls|csv|txt|tsv)$/i.test(file.name))
    throw new ImportError('Choose an Excel (.xlsx, .xls) or CSV (.csv) file.');
  if (file.size > MAX_FILE_BYTES) throw new ImportError('The file is larger than 60 MB. Export fewer columns or split the search.');
  return parseTable(await file.arrayBuffer(), file.name);
}

/** Column values by header (for previews and date detection). */
export function column(table: RawTable, header: string | undefined, limit = Infinity): Cell[] {
  if (!header) return [];
  const i = table.headers.indexOf(header);
  if (i < 0) return [];
  const out: Cell[] = [];
  for (const r of table.rows) {
    if (out.length >= limit) break;
    out.push(r[i] ?? null);
  }
  return out;
}
