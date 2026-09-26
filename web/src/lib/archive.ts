export const EXIT_MS = 200;
export const STAGGER_MS = 30;
// caps the wave so a large batch still finishes in ~700ms
export const MAX_STAGGER_SPAN_MS = 500;

export function exitDelays(count: number): number[] {
  const step = count <= 1 ? 0 : Math.min(STAGGER_MS, MAX_STAGGER_SPAN_MS / (count - 1));
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

export function exitTotalMs(count: number): number {
  return count === 0 ? 0 : (exitDelays(count).at(-1) ?? 0) + EXIT_MS;
}
