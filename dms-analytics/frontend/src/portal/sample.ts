/**
 * A clearly fictional sample export, shaped like an iManage Work search export
 * (a document list) plus a matter list. Generated in the page, relative to
 * today, so the controls produce a realistic mix of results.
 * Every name is invented ("Partner Alpha", "Amber Example Ltd").
 */
import { FEE_EARNERS, OFFICES, PARTNERS, PRACTICE_AREAS, mulberry32 } from '../mocks/data';
import type { Cell, RawTable } from './readFile';

const DAY = 86_400_000;
const CLIENT_WORDS = ['Amber', 'Birch', 'Cobalt', 'Delta', 'Elm', 'Fern', 'Granite', 'Harbour', 'Indigo', 'Juniper', 'Kestrel',
  'Linden', 'Maple', 'Nimbus', 'Oak', 'Pine', 'Quartz', 'Rowan', 'Slate', 'Thistle'];
const CLIENT_SUFFIX = ['Example Ltd', 'Sample Holdings DAC', 'Demo Properties Ltd', 'Example Trust'];
const MATTER_NAMES = ['Supply agreement', 'Share purchase', 'Lease renewal', 'Contract claim', 'Estate administration',
  'Facility agreement', 'Employment dispute', 'Debt recovery', 'Site acquisition', 'Shareholder agreement'];
const TYPES: Record<string, string> = {
  'Banking & Finance': 'BANK', Commercial: 'COMM', Corporate: 'CORP', Employment: 'EMP', Litigation: 'LIT', 'Private Client': 'PC', Property: 'PROP',
};
const SUBSTANTIVE: [string, string][] = [
  ['CORR', 'Letter to other side'], ['CORR', 'Email to client re next steps'], ['DRAFT', 'Draft agreement v2'],
  ['RESEARCH', 'Research memo on limitation'], ['DRAFT', 'Board minutes (draft)'], ['PLEADING', 'Statement of claim'],
  ['CORR', 'Letter from counterparty'], ['NOTE', 'File note - document review'],
];

export const SAMPLE_DOC_HEADERS = ['Document Number', 'Version', 'Name', 'Class', 'Subclass', 'Author', 'Last Edited By',
  'Create Date', 'Edit Date', 'Client', 'Matter', 'Workspace Name', 'Location'];
export const SAMPLE_MATTER_HEADERS = ['Client', 'Client Name', 'Matter', 'Matter Name', 'Practice Area', 'Partner',
  'Responsible Fee Earner', 'Office', 'Status', 'Open Date', 'Close Date', 'Matter Type', 'Key Date'];

const p2 = (n: number) => String(n).padStart(2, '0');
/** Irish-style export text: dd/mm/yyyy hh:mm. */
const ie = (t: number) => {
  const d = new Date(t);
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
};
const ieDate = (t: number) => ie(t).slice(0, 10);

export function generateSampleExport(nowNaive: number, matterCount = 150, seed = 4242): { docs: RawTable; matters: RawTable } {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const docRows: Cell[][] = [];
  const matterRows: Cell[][] = [];
  let docNo = 41_000;
  const today = Math.floor(nowNaive / DAY) * DAY;
  const perClient = new Map<number, number>();

  for (let i = 0; i < matterCount; i++) {
    const ci = Math.floor(r() * 60);
    const client = `C${10001 + ci}`;
    const clientName = `${CLIENT_WORDS[ci % CLIENT_WORDS.length]} ${CLIENT_SUFFIX[Math.floor(ci / CLIENT_WORDS.length) % CLIENT_SUFFIX.length]}`;
    const seq = (perClient.get(ci) ?? 0) + 1;
    perClient.set(ci, seq);
    const matter = String(seq).padStart(4, '0');
    const practice = pick(PRACTICE_AREAS);
    const pIdx = Math.floor(r() * PARTNERS.length);
    const partner = PARTNERS[pIdx]!;
    const fe = FEE_EARNERS[(pIdx * 2 + Math.floor(r() * 2)) % FEE_EARNERS.length]!;
    const office = OFFICES[r() < 0.6 ? 1 : r() < 0.5 ? 0 : 2]!;
    const matterName = pick(MATTER_NAMES);
    const quality = Math.min(1, Math.max(0, 0.55 + (pIdx % 4) * 0.09 - (practice === 'Litigation' ? 0.15 : 0) + (r() - 0.5) * 0.5));
    const ok = () => r() < 0.45 + quality * 0.5;
    const age = Math.max(4, Math.floor(Math.pow(r(), 1.7) * 2200));
    const opened = today - age * DAY + (9 + Math.floor(r() * 8)) * 3_600_000;
    const closed = age > 300 && r() < 0.25;
    const closeDate = closed ? opened + Math.floor(age * (0.5 + r() * 0.4)) * DAY : null;
    const dormant = !closed && age > 400 && r() < 0.12;
    const lastPossible = closeDate ?? (dormant ? today - (380 + Math.floor(r() * 200)) * DAY : nowNaive - 3_600_000);
    const workspace = `${clientName} - ${matterName}`;
    const matterType = r() < 0.05 ? 'INTERNAL' : TYPES[practice] ?? 'GEN';
    const keyDate = !closed && r() < 0.6 ? today + Math.floor(r() * 200 - 20) * DAY : null;
    matterRows.push([client, clientName, matter, matterName, practice, partner.name, fe.name, office,
      closed ? 'Closed' : 'Open', ieDate(opened), closeDate ? ieDate(closeDate) : null, matterType, keyDate ? ieDate(keyDate) : null]);

    const authorId = fe.name.replace(/^Fee Earner /, 'FE.').toUpperCase();
    const at = (t: number) => Math.min(Math.max(t, opened), lastPossible);
    const add = (cls: string, sub: string | null, name: string, created: number, editedAfterDays = 0) => {
      const c = at(created);
      const e = Math.min(lastPossible, c + editedAfterDays * DAY);
      docNo += 1 + Math.floor(r() * 3);
      const row: Cell[] = [String(docNo), '1', name, cls, sub, authorId, authorId, ie(c), ie(e), client, matter, workspace, `${workspace} / ${cls === 'BILL' ? 'Billing' : 'Documents'}`];
      docRows.push(row);
      if (r() < 0.12) {
        // A second version of the same document.
        const e2 = Math.min(lastPossible, e + Math.floor(r() * 20) * DAY);
        docRows.push([String(docNo), '2', name, cls, sub, authorId, authorId, ie(c), ie(e2), client, matter, workspace, row[12]!]);
      }
    };

    const firstWork = opened + Math.floor(r() * 9) * DAY + 3 * 3_600_000;
    if (ok()) add('FILEOPEN', null, 'File opening form', opened + Math.floor(r() * 4) * DAY);
    else if (r() < 0.6) add('FILEOPEN', null, 'File opening form', opened + (7 + Math.floor(r() * 30)) * DAY);
    if (ok()) add('CONFLICT', null, 'Conflict search clearance', firstWork - Math.floor(r() * 3) * DAY);
    else if (r() < 0.6) add('CONFLICT', null, 'Conflict search clearance', firstWork + (2 + Math.floor(r() * 25)) * DAY);
    const cddAt = ok() ? firstWork - Math.floor(r() * 2) * DAY : firstWork + (3 + Math.floor(r() * 40)) * DAY;
    if (r() < 0.9) add(r() < 0.5 ? 'KYC' : 'AML', null, 'Client ID and address verification', cddAt);
    if (age > 1000 && !closed && r() < 0.5) add('KYC', null, 'KYC refresh', today - Math.floor(r() * 900) * DAY);
    if (ok()) {
      const elAt = firstWork + Math.floor(r() * 12) * DAY;
      add('ENGAGE', null, 'Letter of engagement', elAt);
      if (ok()) add('ENGAGE', r() < 0.5 ? 'SIGNED' : null, 'Letter of engagement - signed', elAt + (5 + Math.floor(r() * 20)) * DAY);
    } else if (r() < 0.5) add('S150', null, 'Section 150 notice', firstWork + (16 + Math.floor(r() * 30)) * DAY);

    const span = Math.max(1, Math.floor((lastPossible - firstWork) / DAY));
    const n = 5 + Math.floor(Math.pow(r(), 1.5) * 30);
    for (let k = 0; k < n; k++) {
      const [cls, name] = pick(SUBSTANTIVE);
      const created = k === 0 ? firstWork : firstWork + Math.floor(r() * span) * DAY;
      add(cls, null, name, created, Math.floor(r() * 10));
    }
    // Recent activity for most open matters.
    if (!closed && !dormant && r() < 0.75) add('CORR', null, 'Email to client re progress', nowNaive - Math.floor(r() * 60) * DAY - 3_600_000);
    // Attendance notes: some by class, some only recognisable by name (the name rule).
    const notes = Math.floor(r() * 4 * quality + (ok() ? 1 : 0));
    for (let k = 0; k < notes; k++) {
      const recent = !closed && !dormant && r() < 0.7;
      const created = recent ? nowNaive - Math.floor(r() * 80) * DAY - 7_200_000 : firstWork + Math.floor(r() * span) * DAY;
      add(r() < 0.5 ? 'ATTNOTE' : 'NOTE', null, 'Attendance note - call with client', created);
    }
    if (age > 365 && !closed) {
      if (ok()) add('COSTS', null, 'Costs update letter', nowNaive - Math.floor(r() * 300) * DAY - 7_200_000);
      else if (r() < 0.5) add('COSTS', null, 'Costs update letter', nowNaive - (400 + Math.floor(r() * 300)) * DAY);
    }
    if (ok()) add('BILL', null, 'Interim bill', closed ? lastPossible - 5 * DAY : nowNaive - Math.floor(r() * 150) * DAY - 7_200_000);
    else if (r() < 0.5) add('BILL', null, 'Interim bill', nowNaive - (200 + Math.floor(r() * 200)) * DAY);
  }
  return {
    docs: { fileName: 'sample-document-export.csv', sheetName: null, headers: SAMPLE_DOC_HEADERS, rows: docRows, headerConfident: true },
    matters: { fileName: 'sample-matter-list.csv', sheetName: null, headers: SAMPLE_MATTER_HEADERS, rows: matterRows, headerConfident: true },
  };
}
