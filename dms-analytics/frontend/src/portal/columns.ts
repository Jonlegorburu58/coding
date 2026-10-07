/**
 * Column mapping for iManage Work exports. Header names vary by version, by
 * library configuration and by the columns the user chose, so every mapping is
 * a suggestion the user can correct.
 */

export type DocField =
  | 'name' | 'number' | 'version' | 'class' | 'subclass' | 'author' | 'operator'
  | 'created' | 'edited' | 'client' | 'matter' | 'workspace' | 'folder';

export type MatterField =
  | 'client' | 'client_name' | 'matter' | 'matter_name' | 'practice_area' | 'partner' | 'fee_earner'
  | 'office' | 'status' | 'opened' | 'closed' | 'matter_type' | 'key_date';

export interface FieldDef<F extends string> {
  field: F;
  label: string;
  help?: string;
  synonyms: string[];
  date?: boolean;
}

export const DOC_FIELDS: FieldDef<DocField>[] = [
  { field: 'name', label: 'Document name', synonyms: ['name', 'description', 'document name', 'doc name', 'title', 'document description', 'document title'] },
  { field: 'number', label: 'Document number', help: 'Used to combine versions of the same document.', synonyms: ['number', 'doc number', 'document number', 'docnum', 'doc no', 'doc #', 'document no', 'doc id', 'document id'] },
  { field: 'version', label: 'Version', synonyms: ['version', 'ver', 'version number', 'doc version'] },
  { field: 'class', label: 'Class', help: 'Needed for the document-type mapping.', synonyms: ['class', 'doc class', 'document class', 'type class'] },
  { field: 'subclass', label: 'Subclass', synonyms: ['subclass', 'sub class', 'doc subclass', 'document subclass'] },
  { field: 'author', label: 'Author', synonyms: ['author', 'created by', 'author id', 'author name'] },
  { field: 'operator', label: 'Last edited by', synonyms: ['operator', 'last edited by', 'last modified by', 'modified by', 'edited by', 'last user', 'typist'] },
  { field: 'created', label: 'Created date', help: 'Required: the filing date the controls use.', date: true, synonyms: ['created', 'create date', 'date created', 'creation date', 'created date', 'created on', 'create'] },
  { field: 'edited', label: 'Last edited date', help: 'Activity date. If not mapped, the created date is used.', date: true, synonyms: ['edited', 'edit date', 'modified', 'last modified', 'date modified', 'last edited', 'edited date', 'modified date', 'last edit date', 'edit time', 'last modified date'] },
  { field: 'client', label: 'Client', synonyms: ['client', 'client number', 'client no', 'client code', 'client id', 'custom1', 'client matter client'] },
  { field: 'matter', label: 'Matter', synonyms: ['matter', 'matter number', 'matter no', 'matter code', 'matter id', 'custom2'] },
  { field: 'workspace', label: 'Workspace', help: 'Used to group documents when there is no Client and Matter.', synonyms: ['workspace', 'workspace name', 'container', 'matter workspace'] },
  { field: 'folder', label: 'Folder / location', synonyms: ['folder', 'location', 'path', 'folder path', 'folder name'] },
];

export const MATTER_FIELDS: FieldDef<MatterField>[] = [
  { field: 'client', label: 'Client', synonyms: ['client', 'client number', 'client no', 'client code', 'client id', 'custom1'] },
  { field: 'client_name', label: 'Client name', synonyms: ['client name', 'client description', 'custom1 description', 'client desc'] },
  { field: 'matter', label: 'Matter', synonyms: ['matter', 'matter number', 'matter no', 'matter code', 'matter id', 'custom2'] },
  { field: 'matter_name', label: 'Matter name', synonyms: ['matter name', 'matter description', 'custom2 description', 'workspace name', 'name', 'description', 'matter desc'] },
  { field: 'practice_area', label: 'Practice area', synonyms: ['practice area', 'practice group', 'department', 'practice', 'area of law', 'team'] },
  { field: 'partner', label: 'Partner', synonyms: ['partner', 'responsible partner', 'matter partner', 'supervising partner', 'billing partner'] },
  { field: 'fee_earner', label: 'Responsible fee earner', synonyms: ['responsible fee earner', 'fee earner', 'responsible lawyer', 'responsible attorney', 'matter owner', 'owner', 'handler', 'responsible'] },
  { field: 'office', label: 'Office', synonyms: ['office', 'location office', 'branch', 'site'] },
  { field: 'status', label: 'Status', synonyms: ['status', 'matter status', 'open closed', 'state'] },
  { field: 'opened', label: 'Open date', date: true, synonyms: ['open date', 'opened', 'date opened', 'opened date', 'matter open date', 'opening date', 'created', 'create date'] },
  { field: 'closed', label: 'Close date', date: true, synonyms: ['close date', 'closed', 'date closed', 'closed date', 'matter close date', 'closing date'] },
  { field: 'matter_type', label: 'Matter type', synonyms: ['matter type', 'type', 'work type', 'matter category'] },
  { field: 'key_date', label: 'Key date', help: 'Without it, CD1 (critical date recorded) shows as Unknown.', date: true, synonyms: ['key date', 'critical date', 'limitation date', 'deadline', 'next key date'] },
];

export type ColumnMapping<F extends string> = Partial<Record<F, string>>;

export const normHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9#]+/g, '');

/**
 * Suggest a column for each field from the headers (case- and space-insensitive).
 * Exact synonym matches win; each header is used at most once.
 */
export function suggestMapping<F extends string>(headers: string[], fields: FieldDef<F>[], previous: ColumnMapping<F> = {}): ColumnMapping<F> {
  const out: ColumnMapping<F> = {};
  const used = new Set<string>();
  const byNorm = new Map<string, string>();
  for (const h of headers) if (!byNorm.has(normHeader(h))) byNorm.set(normHeader(h), h);
  // A remembered mapping is reused when its header is still present.
  for (const f of fields) {
    const p = previous[f.field];
    if (p && headers.includes(p) && !used.has(p)) {
      out[f.field] = p;
      used.add(p);
    }
  }
  for (const f of fields) {
    if (out[f.field]) continue;
    for (const syn of f.synonyms) {
      const h = byNorm.get(normHeader(syn));
      if (h && !used.has(h)) {
        out[f.field] = h;
        used.add(h);
        break;
      }
    }
  }
  return out;
}
