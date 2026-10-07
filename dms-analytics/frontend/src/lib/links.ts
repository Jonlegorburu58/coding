import type { BreakdownRow, Dimension } from '../api/types';
import { DIMENSIONS } from './status';
import { filterQuery, type GlobalFilters } from '../state/filters';

/** Turn a heatmap row/cell into the matter-list URL for that slice. */
export function heatmapCellLink(filters: GlobalFilters, dimension: Dimension, row: BreakdownRow, controlId: string): string {
  const slice: GlobalFilters = { ...filters };
  if (dimension === 'opened_month') {
    const [y, m] = row.key.split('-').map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    slice.opened_from = `${row.key}-01`;
    slice.opened_to = `${row.key}-${String(last).padStart(2, '0')}`;
  } else {
    slice[DIMENSIONS.find((d) => d.value === dimension)!.param] = row.key;
  }
  return `/matters${filterQuery(slice, { failing_control: controlId })}`;
}
