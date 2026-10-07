import type { ApiErrorBody } from './types';

/**
 * All calls are same-origin relative URLs. The session lives in an HttpOnly
 * cookie the browser sends automatically; this code never sees or stores a token.
 */
export const APP_HEADER = { 'X-DMS-Analytics': '1' } as const;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** Raised for HTTP 401: the session cookie is missing or expired. */
export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, 'unauthorized', 'Your session has expired.');
    this.name = 'SessionExpiredError';
  }
}

type SessionListener = () => void;
const expiredListeners = new Set<SessionListener>();
export function onSessionExpired(fn: SessionListener): () => void {
  expiredListeners.add(fn);
  return () => expiredListeners.delete(fn);
}

const FRIENDLY_FALLBACK =
  'Something went wrong while loading this information. Please try again in a moment.';
const OFFLINE_MESSAGE =
  'The analytics app is not responding. Check that it is still running, then try again.';

export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;

export function toQueryString(params?: QueryParams): string {
  if (!params) return '';
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

async function readError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    body = null;
  }
  const message = typeof body?.message === 'string' && body.message.trim() ? body.message : FRIENDLY_FALLBACK;
  const code = typeof body?.code === 'string' ? body.code : `http_${res.status}`;
  return new ApiError(res.status, code, message);
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  options: { query?: QueryParams; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  if (!path.startsWith('/api/')) throw new Error('Only /api paths are allowed');
  const headers: Record<string, string> = { ...APP_HEADER, Accept: 'application/json' };
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let res: Response;
  try {
    // Absolute same-origin URL (identical to a relative one in the browser; also works under jsdom).
    const url = new URL(path + toQueryString(options.query), window.location.href);
    res = await fetch(url, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: options.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network', OFFLINE_MESSAGE);
  }
  if (res.status === 401) {
    expiredListeners.forEach((fn) => fn());
    throw new SessionExpiredError();
  }
  if (!res.ok) throw await readError(res);
  if (res.status === 204 || res.status === 202) {
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
  return (await res.json()) as T;
}

export const apiGet = <T>(path: string, query?: QueryParams, signal?: AbortSignal) =>
  apiRequest<T>('GET', path, { query, signal });
export const apiPost = <T>(path: string, body?: unknown) => apiRequest<T>('POST', path, { body });
export const apiPut = <T>(path: string, body?: unknown) => apiRequest<T>('PUT', path, { body });

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return FRIENDLY_FALLBACK;
}
