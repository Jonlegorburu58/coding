import { afterEach, describe, expect, it, vi } from 'vitest';
import { utils, write } from 'xlsx';
import { detectDayOrder, fromExcelSerial, parseDate } from './dates';
import { DOC_FIELDS, MATTER_FIELDS, suggestMapping } from './columns';
import { classify, configuredTypes, distinctClasses, suggestType, withSuggestions, type TypeMapping } from './doctypes';
import { parseTable, ImportError } from './readFile';
import { buildDataset, codeKey } from './build';
import { generateSampleExport, SAMPLE_DOC_HEADERS } from './sample';
import { defaultSettings, loadSettings, parseSettingsText, sanitizeSettings, saveSettings, serializeSettings } from './settings';
import { apiPath } from './shim';

const U = (y: number, m: number, d: number, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi);
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;

describe('dates', () => {
  it('reads Irish day-first dates, with and without times', () => {
    expect(parseDate('03/04/2026')).toBe(U(2026, 4, 3));
    expect(parseDate('03/04/2026', 'mdy')).toBe(U(2026, 3, 4));
    expect(parseDate('31/01/2026 14:05')).toBe(U(2026, 1, 31, 14, 5));
    expect(parseDate('1/2/26 2:05 PM')).toBe(U(2026, 2, 1, 14, 5));
    expect(parseDate('31.12.2025')).toBe(U(2025, 12, 31));
    expect(parseDate('5 Mar 2026')).toBe(U(2026, 3, 5));
    expect(parseDate('05-Mar-2026 09:30')).toBe(U(2026, 3, 5, 9, 30));
    expect(parseDate('March 5, 2026')).toBe(U(2026, 3, 5));
  });
  it('reads ISO dates and converts explicit offsets to UTC', () => {
    expect(parseDate('2026-03-05')).toBe(U(2026, 3, 5));
    expect(parseDate('2026-03-05T10:15:00')).toBe(U(2026, 3, 5, 10, 15));
    expect(parseDate('2026-03-05T10:15:00Z')).toBe(U(2026, 3, 5, 10, 15));
    expect(parseDate('2026-03-05T10:15:00+01:00')).toBe(U(2026, 3, 5, 9, 15));
  });
  it('reads Excel serial numbers (including in CSV text)', () => {
    expect(fromExcelSerial(46000)).toBe(U(2025, 12, 9));
    expect(parseDate(46000.5)).toBe(U(2025, 12, 9, 12));
    expect(parseDate('46000')).toBe(U(2025, 12, 9));
    expect(parseDate(59)).toBe(U(1900, 2, 28)); // before Excel's fictitious 29 Feb 1900
    expect(parseDate(61)).toBe(U(1900, 3, 1));
  });
  it('rejects impossible or empty values', () => {
    for (const v of ['', '31/02/2026', '13/13/2026', 'not a date', 'Draft v2', null, undefined, '2026-13-01']) expect(parseDate(v as string)).toBeNull();
  });
  it('detects day order from unambiguous values', () => {
    expect(detectDayOrder(['01/02/2026', '25/03/2026'])).toBe('dmy');
    expect(detectDayOrder(['03/25/2026', '01/02/2026'])).toBe('mdy');
    expect(detectDayOrder(['01/02/2026', 46000])).toBeNull();
  });
});

describe('column mapping suggestions', () => {
  it('matches typical iManage export headers, case- and space-insensitively', () => {
    const m = suggestMapping(['DOC NUMBER', 'Ver', 'Description', 'Class', 'Sub Class', 'Author', 'Operator', 'Date Created', 'Last Modified', 'custom1', 'custom2', 'Workspace Name', 'Path'], DOC_FIELDS);
    expect(m).toEqual({
      number: 'DOC NUMBER', version: 'Ver', name: 'Description', class: 'Class', subclass: 'Sub Class', author: 'Author', operator: 'Operator',
      created: 'Date Created', edited: 'Last Modified', client: 'custom1', matter: 'custom2', workspace: 'Workspace Name', folder: 'Path',
    });
  });
  it('uses each column once and keeps remembered choices that still exist', () => {
    const m = suggestMapping(['Name', 'Description', 'Created'], DOC_FIELDS, { name: 'Description' });
    expect(m.name).toBe('Description');
    expect(m.created).toBe('Created');
    const mm = suggestMapping(['Client', 'Matter', 'Matter Name', 'Responsible Fee Earner', 'Open Date', 'Key Date'], MATTER_FIELDS);
    expect(mm).toMatchObject({ client: 'Client', matter: 'Matter', matter_name: 'Matter Name', fee_earner: 'Responsible Fee Earner', opened: 'Open Date', key_date: 'Key Date' });
  });
});

describe('document types', () => {
  it('suggests canonical types from class names', () => {
    expect(suggestType('FILEOPEN')).toBe('file_opening');
    expect(suggestType('Conflict Check')).toBe('conflict_clearance');
    expect(suggestType('KYC')).toBe('cdd');
    expect(suggestType('ENGAGE')).toBe('engagement_letter');
    expect(suggestType('ENGAGE', 'SIGNED')).toBe('engagement_signed');
    expect(suggestType('S150')).toBe('s150_notice');
    expect(suggestType('ATTNOTE')).toBe('attendance_note');
    expect(suggestType('COSTS')).toBe('costs_update');
    expect(suggestType('INVOICE')).toBe('bill');
    expect(suggestType('CORR')).toBe('other');
    expect(suggestType('DUE DILIGENCE')).toBe('other'); // corporate DD reports are substantive work
  });
  it('applies subclass overrides, then class, then name rules for "other"', () => {
    const m: TypeMapping = {
      byClass: { ENGAGE: 'engagement_letter', NOTE: 'other' }, byClassSubclass: { 'ENGAGE|SIGNED': 'engagement_signed', 'ENGAGE|DRAFT': 'inherit' },
      nameRules: [{ contains: 'Attendance Note', type: 'attendance_note' }], signedWords: [],
    };
    expect(classify(m, 'engage', 'signed', 'x')).toBe('engagement_signed');
    expect(classify(m, 'ENGAGE', 'DRAFT', 'x')).toBe('engagement_letter');
    expect(classify(m, 'NOTE', null, 'attendance note - call')).toBe('attendance_note');
    expect(classify(m, 'ENGAGE', null, 'attendance note')).toBe('engagement_letter');
    expect(classify(m, 'UNKNOWN', null, 'memo')).toBeNull();
    const classes = distinctClasses([{ cls: 'ENGAGE', sub: 'SIGNED' }, { cls: 'NOTE', sub: null }]);
    expect([...configuredTypes(m, classes)].sort()).toEqual(['attendance_note', 'engagement_letter', 'engagement_signed']);
    const filled = withSuggestions({ ...m, byClass: {} }, distinctClasses([{ cls: 'BILL', sub: null }]));
    expect(filled.byClass.BILL).toBe('bill');
  });
});

describe('reading files', () => {
  it('parses CSV as text (dates untouched), finds the header row and trims cells', () => {
    const t = parseTable(enc('\uFEFFSearch results\n\nName,Class,Create Date,Client,Matter\n"Letter, final",CORR,03/04/2026 10:00,C1,0007\n , ,,,\n'), 'x.csv');
    expect(t.headers).toEqual(['Name', 'Class', 'Create Date', 'Client', 'Matter']);
    expect(t.rows).toEqual([['Letter, final', 'CORR', '03/04/2026 10:00', 'C1', '0007']]);
    expect(t.headerConfident).toBe(true);
  });
  it('parses .xlsx with date cells as serial numbers', () => {
    const wb = utils.book_new();
    utils.book_append_sheet(wb, utils.aoa_to_sheet([['Name', 'Created', 'Client', 'Matter'], ['Memo', 46000, 'C1', '1']]), 'S');
    const buf = write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    const t = parseTable(buf, 'x.xlsx');
    expect(t.sheetName).toBe('S');
    expect(parseDate(t.rows[0]![1]!)).toBe(U(2025, 12, 9));
  });
  it('rejects empty or unreadable files with a plain message', () => {
    expect(() => parseTable(new ArrayBuffer(0), 'x.csv')).toThrow(ImportError);
    expect(() => parseTable(enc('just one line'), 'x.csv')).toThrow(/No rows/);
  });
});

describe('building the dataset', () => {
  const now = U(2026, 10, 7, 12);
  it('groups documents into matters, joins the matter list and evaluates every control', () => {
    const s = generateSampleExport(now, 40, 9);
    const settings = defaultSettings();
    settings.docColumns = suggestMapping(s.docs.headers, DOC_FIELDS);
    settings.matterColumns = suggestMapping(s.matters.headers, MATTER_FIELDS);
    settings.types = withSuggestions(settings.types, distinctClasses(s.docs.rows.map((r) => ({ cls: r[3] as string, sub: r[4] as string | null }))));
    const ds = buildDataset({ docs: s.docs, matters: s.matters, isSample: true }, settings, now);
    expect(ds.matters).toHaveLength(40);
    expect(ds.report.mattersOnlyInDocs).toBe(0);
    expect(ds.report.versionsMerged).toBeGreaterThan(0);
    expect(ds.controls.every((c) => c.configured)).toBe(true);
    for (const m of ds.matters) expect(m.controls.map((c) => c.control_id)).toHaveLength(11);
    expect(ds.coverageNote).toContain('Held only in this browser tab');
    expect(ds.matters.some((m) => m.status === 'closed')).toBe(true);
    expect(ds.filters.partners.length).toBeGreaterThan(1);
  });
  it('without a matter list: earliest document opens the matter, everything open, profile Unassigned, CD1 unknown', () => {
    const docs = parseTable(enc([
      'Number,Name,Class,Created,Edited,Client,Matter',
      '1,File opening form,FILEOPEN,10/01/2026,10/01/2026,C1,0001',
      '2,Draft letter,CORR,12/01/2026,20/09/2026,C1,1',
      '3,Memo,CORR,bad date,,C1,0001',
      '4,Orphan,CORR,12/01/2026,,,',
    ].join('\n')), 'docs.csv');
    const settings = defaultSettings();
    settings.docColumns = suggestMapping(docs.headers, DOC_FIELDS);
    settings.types = withSuggestions(settings.types, distinctClasses([{ cls: 'FILEOPEN', sub: null }, { cls: 'CORR', sub: null }]));
    const ds = buildDataset({ docs, matters: null, isSample: false }, settings, now);
    expect(ds.matters).toHaveLength(1); // "0001" and "1" are the same matter (Excel drops leading zeros)
    const m = ds.matters[0]!;
    expect(m.opened_at).toBe('2026-01-10T00:00:00Z');
    expect(m.status).toBe('open');
    expect(m.practice_area).toBe('Unassigned');
    expect(m.doc_count).toBe(2);
    expect(m.controls.find((c) => c.control_id === 'CD1')!.status).toBe('unknown');
    expect(m.controls.find((c) => c.control_id === 'FO1')!.status).toBe('pass');
    expect(m.controls.find((c) => c.control_id === 'CF1')!.status).toBe('unknown');
    expect(ds.report.skippedNoCreated).toBe(1);
    expect(ds.report.skippedNoMatter).toBe(1);
    expect(ds.report.notes.join(' ')).toContain('earliest document');
    expect(codeKey(' 007 ')).toBe('7');
  });
  it('refuses to run without a created date or a way to group documents', () => {
    const docs = parseTable(enc('Name,Class\nA,B\n'), 'd.csv');
    expect(() => buildDataset({ docs, matters: null, isSample: false }, defaultSettings(), now)).toThrow(/Created date/);
  });
  it('the sample export has the iManage-style headers', () => {
    expect(generateSampleExport(now, 3).docs.headers).toEqual(SAMPLE_DOC_HEADERS);
  });
});

describe('settings (mapping only, never rows)', () => {
  afterEach(() => window.localStorage.clear());
  it('round-trips through copy/paste text and drops unknown or malformed fields', () => {
    const s = defaultSettings();
    s.docColumns = { created: 'Create Date' };
    s.types.byClass = { BILL: 'bill' };
    s.thresholds.FO1_days = 7;
    const back = parseSettingsText(serializeSettings(s))!;
    expect(back).toEqual(s);
    expect(parseSettingsText('{"rows":[["client data"]]}')).toBeNull();
    const dirty = sanitizeSettings({ rows: [['x']], docColumns: { created: 'A', evil: 'B' }, thresholds: { FO1_days: -1 }, types: { byClass: { X: 'nonsense' } } });
    expect(dirty).not.toHaveProperty('rows');
    expect(dirty.docColumns).toEqual({ created: 'A' });
    expect(dirty.thresholds.FO1_days).toBe(5);
    expect(dirty.types.byClass).toEqual({});
  });
  it('remembers settings only, and only recognised column names', () => {
    const s = defaultSettings();
    s.docColumns = { created: 'Create Date' };
    s.types.byClass = { BILL: 'bill' };
    saveSettings(s, { docs: false, matters: false, classes: false });
    const stored = window.localStorage.getItem('bws-dms-portal-settings-v1')!;
    expect(stored).not.toContain('Create Date');
    expect(stored).not.toContain('BILL');
    saveSettings(s, { docs: true, matters: true, classes: true });
    expect(loadSettings().docColumns.created).toBe('Create Date');
  });
  it('works when storage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(loadSettings()).toEqual(defaultSettings());
    spy.mockRestore();
  });
});

describe('in-page API path matching', () => {
  it('recognises /api paths on http, file:// and Windows drive file URLs', () => {
    expect(apiPath('/api/session')).toBe('/api/session');
    expect(apiPath(new URL('file:///C:/api/matters?q=a'))).toBe('/api/matters?q=a');
    expect(apiPath('file:///home/u/api/x')).toBeNull();
    expect(apiPath('https://example.invalid/collect')).toBeNull();
  });
});
