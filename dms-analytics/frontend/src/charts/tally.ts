import type { ControlTally } from '../api/types';

export const STACK_KEYS = ['pass', 'late', 'missing', 'stale'] as const;

export function sortByRate(tallies: ControlTally[]): ControlTally[] {
  return [...tallies].sort((a, b) => (a.compliance_rate ?? 2) - (b.compliance_rate ?? 2) || a.control_id.localeCompare(b.control_id));
}
