/** Seven bins on one blue hue. Index 0 = highest compliance; 6 = lowest. */
export const HEAT_BINS = [
  { min: 0.95, label: '95%+' },
  { min: 0.9, label: '90–95' },
  { min: 0.85, label: '85–90' },
  { min: 0.8, label: '80–85' },
  { min: 0.7, label: '70–80' },
  { min: 0.6, label: '60–70' },
  { min: -1, label: '<60%' },
];
export function heatBin(rate: number): number {
  return HEAT_BINS.findIndex((b) => rate >= b.min);
}
