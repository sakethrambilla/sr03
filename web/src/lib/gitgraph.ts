// The commit graph's geometry and lane assignment, kept out of the component so it is pure — no
// React, no DOM — and so the lane output can be pinned by `node --test`.
import type { Commit } from "./types.ts";

export const ROW_HEIGHT = 28;
export const LANE_WIDTH = 16;
export const OVERSCAN = 20;
export const FILTER_DEBOUNCE_MS = 150;
export const UNCOMMITTED = "uncommitted";

export interface GraphRow {
  commit: Commit;
  lane: number;
}

// Single-pass lane assignment: each lane holds the hash it's waiting to place next. A
// commit takes over the first lane already waiting for it (or the first free lane, or a new
// one), then hands its lane to its first parent and gives any additional parents (merges)
// their own lanes. Any other lane still waiting for this same hash converges here and frees.
export function layoutGraph(commits: readonly Commit[]): { rows: GraphRow[]; laneCount: number } {
  const lanes: Array<string | null> = [];
  const rows: GraphRow[] = [];
  const findLane = (hash: string) => lanes.indexOf(hash);
  const freeLane = () => {
    const index = lanes.indexOf(null);
    if (index !== -1) return index;
    lanes.push(null);
    return lanes.length - 1;
  };
  for (const commit of commits) {
    let lane = findLane(commit.hash);
    if (lane === -1) lane = freeLane();
    for (let index = 0; index < lanes.length; index += 1) {
      if (index !== lane && lanes[index] === commit.hash) lanes[index] = null;
    }
    lanes[lane] = commit.parents[0] ?? null;
    for (const parent of commit.parents.slice(1)) {
      const existing = findLane(parent);
      const parentLane = existing !== -1 ? existing : freeLane();
      lanes[parentLane] = parent;
    }
    rows.push({ commit, lane });
  }
  return { rows, laneCount: lanes.length };
}

export function laneColor(lane: number): string {
  return `var(--graph-lane-${(lane % 8) + 1})`;
}

// prepends a synthetic node for the dirty working tree so layoutGraph handles it like any
// other commit — it gets a lane and an edge down to HEAD without special-casing row math
export function withUncommitted(
  commits: readonly Commit[],
  headHash: string | null,
  dirty: boolean,
): Commit[] {
  if (!dirty || !headHash) return [...commits];
  return [
    {
      hash: UNCOMMITTED,
      parents: [headHash],
      authorName: "",
      authorEmail: "",
      authorDate: 0,
      message: "Uncommitted changes",
    },
    ...commits,
  ];
}

/** `needle` must already be trimmed and lowercased by the caller. */
export function matchesFilter(commit: Commit, needle: string): boolean {
  return (
    commit.message.toLowerCase().includes(needle) ||
    commit.authorName.toLowerCase().includes(needle) ||
    commit.hash.startsWith(needle)
  );
}
