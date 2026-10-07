import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

/** Global portfolio filters, always kept in the URL query string. */
export const FILTER_KEYS = [
  'practice_area',
  'partner_id',
  'fee_earner_id',
  'office',
  'status',
  'opened_from',
  'opened_to',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type GlobalFilters = Partial<Record<FilterKey, string>>;

export function readFilters(params: URLSearchParams): GlobalFilters {
  const out: GlobalFilters = {};
  for (const k of FILTER_KEYS) {
    const v = params.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/** Query string carrying only the global filters (for nav links). */
export function filterQuery(filters: GlobalFilters, extra?: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v) usp.set(k, v);
  }
  if (extra) for (const [k, v] of Object.entries(extra)) if (v) usp.set(k, v);
  const s = usp.toString();
  return s ? `?${s}` : '';
}

export function useGlobalFilters() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const setFilter = useCallback(
    (key: string, value: string | undefined) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value) next.set(key, value);
          else next.delete(key);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const clearFilters = useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const k of FILTER_KEYS) next.delete(k);
        next.delete('page');
        return next;
      },
      { replace: true },
    );
  }, [setParams]);
  const activeCount = Object.keys(filters).length;
  return { filters, params, setParams, setFilter, clearFilters, activeCount };
}
