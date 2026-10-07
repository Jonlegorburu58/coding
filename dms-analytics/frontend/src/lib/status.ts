import type { ControlStatus } from '../api/types';

export interface StatusMeta {
  label: string;
  cls: 'pass' | 'late' | 'missing' | 'stale' | 'neutral';
  icon: 'check' | 'clock' | 'cross' | 'hourglass' | 'pending' | 'dash' | 'question';
  help: string;
}

export const STATUS: Record<ControlStatus, StatusMeta> = {
  pass: { label: 'Pass', cls: 'pass', icon: 'check', help: 'Evidence is on file in time.' },
  late: { label: 'Late', cls: 'late', icon: 'clock', help: 'Evidence is on file, but was filed after the deadline.' },
  missing: { label: 'Missing', cls: 'missing', icon: 'cross', help: 'No evidence found on file.' },
  stale: { label: 'Stale', cls: 'stale', icon: 'hourglass', help: 'Evidence is on file but out of date.' },
  pending: { label: 'Pending', cls: 'neutral', icon: 'pending', help: 'Not due yet.' },
  not_applicable: { label: 'N/A', cls: 'neutral', icon: 'dash', help: 'Does not apply to this matter.' },
  unknown: { label: 'Unknown', cls: 'neutral', icon: 'question', help: 'Cannot be checked: the mapping is not configured or the data is unavailable.' },
};

export type RiskLevel = 'high' | 'medium' | 'low' | 'none';
export function riskLevel(score: number | null | undefined): RiskLevel {
  if (score === null || score === undefined) return 'none';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}
export const RISK_LABEL: Record<RiskLevel, string> = { high: 'High', medium: 'Medium', low: 'Low', none: 'Not scored' };

export const DIMENSIONS = [
  { value: 'practice_area', label: 'Practice area', param: 'practice_area' },
  { value: 'partner', label: 'Partner', param: 'partner_id' },
  { value: 'fee_earner', label: 'Fee earner', param: 'fee_earner_id' },
  { value: 'office', label: 'Office', param: 'office' },
] as const;

export const BASIS_TEXT =
  'iManage filing evidence: shows whether evidence is on file, not whether the step happened.';

export const CANONICAL_TYPE_LABEL: Record<string, string> = {
  correspondence: 'Correspondence',
  draft: 'Drafts',
  attendance_note: 'Attendance notes',
  bill: 'Bills',
  cdd: 'CDD documents',
  engagement_letter: 'Engagement letters',
  engagement_signed: 'Signed engagement letters',
  file_opening: 'File-opening forms',
  conflict_clearance: 'Conflict clearances',
  costs_update: 'Costs updates',
  s150_notice: 's.150 notices',
};
export const typeLabel = (t: string | null) => (t === null ? 'Unmapped / other' : (CANONICAL_TYPE_LABEL[t] ?? t.replace(/_/g, ' ')));
