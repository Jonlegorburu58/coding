/**
 * The data the in-page API handlers serve. Mock and demo builds use the
 * synthetic firm; the portal build swaps in a dataset computed from an imported
 * export (see src/portal/build.ts).
 */
import type { ControlDef, Filters, Session, TrendPoint } from '../api/types';
import { CONTROLS, FEE_EARNERS, MOCK_NOW, OFFICES, PARTNERS, PRACTICE_AREAS, generateMatters, generateTrend, type MockMatter } from './data';

export interface MockDataset {
  matters: MockMatter[];
  controls: ControlDef[];
  filters: Filters;
  /** "Today" for key-date arithmetic. */
  now: Date;
  coverage: Session['coverage'];
  coverageNote: string;
  sourceName: string;
  userDisplayName: string;
  trend: (controlId: string) => TrendPoint[];
  /**
   * Use the backend's scopes (D107): exceptions and the Lexcel sample cover open
   * matters only. The synthetic mock historically covers all statuses.
   */
  backendScopes?: boolean;
}

let synthetic: MockDataset | null = null;

export function syntheticDataset(): MockDataset {
  if (synthetic) return synthetic;
  const matters = generateMatters();
  synthetic = {
    matters,
    controls: CONTROLS,
    filters: {
      practice_areas: PRACTICE_AREAS, partners: PARTNERS, fee_earners: FEE_EARNERS, offices: OFFICES,
      opened_range: { min: '2019-10-03', max: '2026-10-03' },
    },
    now: MOCK_NOW,
    coverage: { libraries: 1, workspaces_visible: matters.length, documents: matters.reduce((a, m) => a + m.doc_count, 0) },
    coverageNote: `Based on ${matters.length} workspaces visible to you in 1 library.`,
    sourceName: 'Mock iManage (synthetic data)',
    userDisplayName: 'Demo User',
    trend: generateTrend,
  };
  return synthetic;
}

let current: MockDataset | null = null;

/** The dataset the handlers serve right now. */
export function currentDataset(): MockDataset {
  return current ?? syntheticDataset();
}

/** Swap the served dataset; `null` restores the synthetic firm. */
export function setDataset(d: MockDataset | null) {
  current = d;
}
