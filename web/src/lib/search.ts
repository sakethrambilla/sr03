// Fuzzy ranking for the quick-open palette, ported from t3code's searchRanking.ts. Matching is
// tiered — exact, prefix, word boundary, substring, subsequence — and each tier's base sits far
// enough above the last that a weaker kind of match can never outrank a stronger one. Lower wins.

const EXACT = 0;
const PREFIX = 100;
const BOUNDARY = 200;
const INCLUDES = 300;
const FUZZY = 400;

// a hit in the directory part counts for less than one in the file's own name, by a margin
// wider than any single tier — so `chatv` finds ChatView.tsx before a path that spells it out
const PATH_PENALTY = 1000;

const BOUNDARIES = ["/", "-", "_", ".", " "];

function lengthPenalty(value: string, query: string): number {
  return Math.min(64, Math.max(0, value.length - query.length));
}

// how far into `value` the whole query sits, when it starts right after a separator
function boundaryIndex(value: string, query: string): number | null {
  let best: number | null = null;
  for (const marker of BOUNDARIES) {
    const found = value.indexOf(marker + query);
    if (found === -1) continue;
    const at = found + marker.length;
    if (best === null || at < best) best = at;
  }
  return best;
}

// every query character in order, scoring an early, tight, gapless run best
function scoreSubsequence(value: string, query: string): number | null {
  let queryIndex = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue;
    if (first === -1) first = index;
    if (previous !== -1) gaps += index - previous - 1;
    previous = index;
    queryIndex += 1;
    if (queryIndex === query.length) {
      const span = index - first + 1 - query.length;
      return first * 2 + gaps * 3 + span + lengthPenalty(value, query);
    }
  }
  return null;
}

function score(value: string, query: string): number | null {
  if (value === query) return EXACT;
  if (value.startsWith(query)) return PREFIX + lengthPenalty(value, query);
  const boundary = boundaryIndex(value, query);
  if (boundary !== null) return BOUNDARY + boundary * 2 + lengthPenalty(value, query);
  const includes = value.indexOf(query);
  if (includes !== -1) return INCLUDES + includes * 2 + lengthPenalty(value, query);
  const fuzzy = scoreSubsequence(value, query);
  return fuzzy === null ? null : FUZZY + fuzzy;
}

// both arguments must already be lowercased
export function scoreFile(path: string, query: string): number | null {
  const byName = score(path.slice(path.lastIndexOf("/") + 1), query);
  const byPath = score(path, query);
  if (byPath === null) return byName;
  if (byName === null) return byPath + PATH_PENALTY;
  return Math.min(byName, byPath + PATH_PENALTY);
}

export function rankFiles(files: string[], query: string, limit: number): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files.slice(0, limit);

  const ranked: Array<{ path: string; score: number }> = [];
  for (const path of files) {
    const value = scoreFile(path.toLowerCase(), needle);
    if (value !== null) ranked.push({ path, score: value });
  }
  // ties break on the path, so the order doesn't reshuffle between keystrokes
  ranked.sort((a, b) => a.score - b.score || a.path.localeCompare(b.path));
  return ranked.slice(0, limit).map((entry) => entry.path);
}
