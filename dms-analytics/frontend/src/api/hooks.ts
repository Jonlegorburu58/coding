import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, type QueryParams } from './client';
import type {
  Breakdown,
  ControlDef,
  Dimension,
  ExceptionPage,
  Filters,
  KeyDate,
  LexcelSample,
  MatterDetail,
  MatterPage,
  PortfolioSummary,
  Session,
  Settings,
  SettingsUpdate,
  SignInStart,
  SyncKind,
  SyncStatus,
  Trend,
} from './types';
import type { GlobalFilters } from '../state/filters';

export const qk = {
  session: ['session'] as const,
  syncStatus: ['sync-status'] as const,
};

export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: ({ signal }) => apiGet<Session>('/api/session', undefined, signal) });
}

export function useSyncStatus() {
  return useQuery({
    queryKey: qk.syncStatus,
    queryFn: ({ signal }) => apiGet<SyncStatus>('/api/sync/status', undefined, signal),
    // Poll every 2 seconds only while a sync is running (brief: live progress).
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'idle' ? 2000 : false),
  });
}

export function useFilterOptions() {
  return useQuery({ queryKey: ['filters'], queryFn: ({ signal }) => apiGet<Filters>('/api/filters', undefined, signal) });
}

export function useControls() {
  return useQuery({
    queryKey: ['controls'],
    queryFn: ({ signal }) => apiGet<ControlDef[]>('/api/controls', undefined, signal),
    staleTime: 5 * 60_000,
  });
}

export function usePortfolioSummary(filters: GlobalFilters) {
  return useQuery({
    queryKey: ['summary', filters],
    queryFn: ({ signal }) => apiGet<PortfolioSummary>('/api/portfolio/summary', filters, signal),
    placeholderData: keepPreviousData,
  });
}

export function useBreakdown(dimension: Dimension, filters: GlobalFilters) {
  return useQuery({
    queryKey: ['breakdown', dimension, filters],
    queryFn: ({ signal }) => apiGet<Breakdown>('/api/portfolio/breakdown', { dimension, ...filters }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useTrend(controlId: string | undefined) {
  return useQuery({
    queryKey: ['trend', controlId ?? 'ALL'],
    queryFn: ({ signal }) => apiGet<Trend>('/api/portfolio/trend', { control_id: controlId ?? 'ALL' }, signal),
  });
}

export function useMatters(query: QueryParams) {
  return useQuery({
    queryKey: ['matters', query],
    queryFn: ({ signal }) => apiGet<MatterPage>('/api/matters', query, signal),
    placeholderData: keepPreviousData,
  });
}

export function useMatter(id: string) {
  return useQuery({
    queryKey: ['matter', id],
    queryFn: ({ signal }) => apiGet<MatterDetail>(`/api/matters/${encodeURIComponent(id)}`, undefined, signal),
  });
}

export function useExceptions(query: QueryParams) {
  return useQuery({
    queryKey: ['exceptions', query],
    queryFn: ({ signal }) => apiGet<ExceptionPage>('/api/exceptions', query, signal),
    placeholderData: keepPreviousData,
  });
}

export function useKeyDates(withinDays: 30 | 60 | 90) {
  return useQuery({
    queryKey: ['key-dates', withinDays],
    queryFn: ({ signal }) => apiGet<KeyDate[]>('/api/key-dates', { within_days: withinDays }, signal),
    placeholderData: keepPreviousData,
  });
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: ({ signal }) => apiGet<Settings>('/api/settings', undefined, signal) });
}

export function useLexcelSample() {
  return useMutation({
    mutationFn: (q: { per_fee_earner: number; seed?: number; practice_area?: string; office?: string }) =>
      apiGet<LexcelSample>('/api/lexcel/sample', q),
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (s: SettingsUpdate) => apiPut<Settings>('/api/settings', s),
    onSuccess: (data) => qc.setQueryData(['settings'], data),
  });
}

export function useSignIn() {
  return useMutation({ mutationFn: () => apiPost<SignInStart>('/api/auth/sign-in') });
}

/** Sign-out and wipe both drop every cached response from memory. */
export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<void>('/api/auth/sign-out'),
    onSuccess: async () => {
      qc.clear();
      await qc.fetchQuery({ queryKey: qk.session, queryFn: () => apiGet<Session>('/api/session') });
    },
  });
}

export function useWipe() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<void>('/api/data/wipe', { confirm: true }),
    onSuccess: async () => {
      qc.clear();
      await qc.fetchQuery({ queryKey: qk.session, queryFn: () => apiGet<Session>('/api/session') });
    },
  });
}

export function useStartSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: SyncKind) => apiPost<SyncStatus>('/api/sync/start', { kind }),
    onSuccess: (data) => qc.setQueryData(qk.syncStatus, data),
  });
}

export function useCancelSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<void>('/api/sync/cancel'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.syncStatus }),
  });
}
