import { apiGet, type QueryParams } from '../api/client';

/** Page through a list endpoint (max 200 per page) to export every row for the current filters. */
export async function fetchAll<T>(path: string, query: QueryParams, maxRows = 20000): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const res = await apiGet<{ total: number; items: T[] }>(path, { ...query, page, page_size: 200 });
    out.push(...res.items);
    if (res.items.length === 0 || out.length >= res.total || out.length >= maxRows) break;
  }
  return out;
}
