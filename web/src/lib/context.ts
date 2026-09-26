export type ContextBand = "ok" | "warn" | "hot";

export function contextBand(percentage: number): { width: number; band: ContextBand } {
  const pct = Number.isNaN(percentage) ? 0 : percentage;
  const width = Math.min(100, Math.max(0, pct));
  const band: ContextBand = pct < 50 ? "ok" : pct < 80 ? "warn" : "hot";
  return { width, band };
}
