import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/parity.json';
import {
  CONTROL_IDS,
  evaluateMatter,
  pyRound,
  riskScore,
  type ControlId,
  type EngineConfig,
  type Status,
  type Thresholds,
} from './engine';
import { pyRegex } from './doctypes';

/** Parse the fixture's naive ISO datetimes ("2026-10-06T21:00:00" or "2026-10-06") as naive UTC. */
const t = (s: string) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}Z`);
const tn = (s: string | null) => (s === null ? null : t(s));
const isoOut = (n: number | null) => (n === null ? null : new Date(n).toISOString().slice(0, 19));

interface FixtureConfig {
  thresholds: Thresholds; severity: Record<ControlId, number>; configured_types: string[];
  signed_patterns: string[]; aml_exempt: string[]; key_date_mapped: boolean;
}

function toConfig(c: FixtureConfig): EngineConfig {
  return {
    thresholds: c.thresholds, severity: c.severity, configuredTypes: new Set(c.configured_types),
    signedPatterns: c.signed_patterns.map(pyRegex), amlExempt: new Set(c.aml_exempt), keyDateMapped: c.key_date_mapped,
  };
}

const NOW = t(fixture.now);

describe('TS controls engine matches the Python reference engine', () => {
  for (const name of ['full', 'reduced'] as const) {
    const cfg = toConfig(fixture.configs[name] as FixtureConfig);
    const cases = fixture.cases[name];
    it(`${name} config: every control outcome for ${cases.length} matters`, () => {
      const seen: Record<string, Set<Status>> = Object.fromEntries(CONTROL_IDS.map((c) => [c, new Set<Status>()]));
      for (const c of cases) {
        const m = c.matter;
        const outcomes = evaluateMatter(
          { id: m.id, status: m.status as 'open' | 'closed', matterType: m.matter_type, openedAt: t(m.opened_at),
            closedAt: tn(m.closed_at), keyDate: tn(m.key_date) },
          c.docs.map((d) => ({ id: d.id, name: d.name, isIntake: d.is_intake, canonicalType: d.canonical_type,
            createdAt: t(d.created_at), editedAt: t(d.edited_at) })),
          cfg, NOW,
        );
        const actual = outcomes.map((o) => ({
          control_id: o.controlId, status: o.status, explanation: o.explanation, due_at: isoOut(o.dueAt),
          evidence_at: isoOut(o.evidenceAt), days_late: o.daysLate, evidence_doc_ids: o.evidenceDocIds,
        }));
        expect(actual, m.id).toEqual(c.expected);
        expect(riskScore(Object.fromEntries(outcomes.map((o) => [o.controlId, o.status])), cfg.severity), m.id).toBe(c.risk_score);
        for (const o of outcomes) seen[o.controlId]!.add(o.status);
      }
      if (name === 'full') {
        // The fixture must exercise every status each control can produce.
        const want: Record<ControlId, Status[]> = {
          FO1: ['pass', 'late', 'missing', 'pending'], CF1: ['pass', 'late', 'missing', 'pending'],
          AML1: ['pass', 'late', 'missing', 'pending', 'not_applicable'], AML2: ['pass', 'stale', 'missing', 'not_applicable'],
          EL1: ['pass', 'late', 'missing', 'pending'], EL2: ['pass', 'missing', 'pending'], AN1: ['pass', 'missing', 'not_applicable'],
          CD1: ['pass', 'missing'], FE1: ['pass', 'stale', 'missing', 'not_applicable'], FE2: ['pass', 'stale', 'missing', 'not_applicable'],
          HY1: ['pass', 'stale', 'not_applicable'],
        };
        for (const cid of CONTROL_IDS) for (const s of want[cid]) expect(seen[cid]!.has(s), `${cid} ${s}`).toBe(true);
      } else {
        for (const cid of ['CD1', 'FE2', 'EL2']) expect(seen[cid]!.has('unknown'), cid).toBe(true);
      }
    });
  }

  it('rounds like Python (ties to even on the exact binary value)', () => {
    expect(pyRound(6.25, 1)).toBe(6.2);
    expect(pyRound(6.35, 1)).toBe(6.3); // 6.35 is stored just below 6.35
    expect(pyRound(2.675, 2)).toBe(2.67);
    expect(pyRound(0.5, 0)).toBe(0);
    expect(pyRound(1.5, 0)).toBe(2);
    expect(pyRound(100 / 3, 1)).toBe(33.3);
    expect(pyRound(0.8125, 3)).toBe(0.812);
  });
});
