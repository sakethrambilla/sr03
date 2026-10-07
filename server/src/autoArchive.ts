import { pendingApprovals, pendingQuestions } from "./agents/runtime.ts";
import { publish } from "./bus.ts";
import { settings, threads } from "./db.ts";

export const AUTO_ARCHIVE_KEY = "auto-archive";
export const AUTO_ARCHIVE_DAYS_KEY = "auto-archive-days";
const DAY_CHOICES = [1, 2, 7, 14];
const SWEEP_MS = 60 * 60 * 1000;

export function archiveDays(raw: string | undefined): number {
  const days = Number(raw);
  return DAY_CHOICES.includes(days) ? days : 7;
}

export function sweepStale(): void {
  const stored = settings.all();
  if (stored[AUTO_ARCHIVE_KEY] !== "true") return;
  const cutoff = Date.now() - archiveDays(stored[AUTO_ARCHIVE_DAYS_KEY]) * 24 * 60 * 60 * 1000;
  const waiting = [...pendingApprovals(), ...pendingQuestions()].map((pending) => pending.threadId);
  for (const thread of threads.archiveStale(cutoff, waiting)) publish({ type: "thread.updated", thread });
}

export function startAutoArchive(): void {
  sweepStale();
  setInterval(sweepStale, SWEEP_MS).unref();
}
