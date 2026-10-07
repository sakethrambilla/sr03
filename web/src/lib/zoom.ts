// Chrome's preset zoom factors
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

export function stepZoom(factor: number, dir: -1 | 0 | 1): number {
  if (dir === 0) return 1;
  if (dir === 1) return ZOOM_STEPS.find((step) => step > factor + 0.001) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return ZOOM_STEPS.findLast((step) => step < factor - 0.001) ?? ZOOM_STEPS[0];
}

export function zoomPercent(factor: number): string {
  return `${Math.round(factor * 100)}%`;
}
