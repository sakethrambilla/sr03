// A project's commit graph: one lane per branch, computed client-side from parent hashes —
// mirrors mhutchie.git-graph's approach (no layout library, no --graph flag). Read-only for
// v1: click a commit to see its changed files and diffs; no checkout/cherry-pick/merge here.
import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api.ts";
import type { ChangedFile, Commit, CommitFile, Project, Ref } from "../lib/types.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, Pill, cn } from "./ui.tsx";

const PAGE_SIZE = 100;
const ROW_HEIGHT = 28;
const LANE_WIDTH = 16;
const UNCOMMITTED = "uncommitted";

interface GraphRow {
  commit: Commit;
  lane: number;
}

// Single-pass lane assignment: each lane holds the hash it's waiting to place next. A
// commit takes over the first lane already waiting for it (or the first free lane, or a new
// one), then hands its lane to its first parent and gives any additional parents (merges)
// their own lanes. Any other lane still waiting for this same hash converges here and frees.
function layoutGraph(commits: Commit[]): { rows: GraphRow[]; laneCount: number } {
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

function laneColor(lane: number): string {
  return `var(--graph-lane-${(lane % 8) + 1})`;
}

// prepends a synthetic node for the dirty working tree so layoutGraph handles it like any
// other commit — it gets a lane and an edge down to HEAD without special-casing row math
function withUncommitted(commits: Commit[], headHash: string | null, dirty: boolean): Commit[] {
  if (!dirty || !headHash) return commits;
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

function Graph({ rows }: { rows: GraphRow[] }) {
  const rowIndexByHash = useMemo(
    () => new Map(rows.map((row, index) => [row.commit.hash, index])),
    [rows],
  );
  const laneCount = rows.reduce((max, row) => Math.max(max, row.lane + 1), 1);
  const width = laneCount * LANE_WIDTH + LANE_WIDTH / 2;
  const height = rows.length * ROW_HEIGHT;

  const edges = rows.flatMap((row, index) => {
    const y = index * ROW_HEIGHT + ROW_HEIGHT / 2;
    const x = row.lane * LANE_WIDTH + LANE_WIDTH / 2;
    return row.commit.parents.flatMap((parent) => {
      const parentIndex = rowIndexByHash.get(parent);
      if (parentIndex === undefined) return []; // parent is beyond the loaded page
      const parentRow = rows[parentIndex]!;
      const py = parentIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
      const px = parentRow.lane * LANE_WIDTH + LANE_WIDTH / 2;
      return [{ x1: x, y1: y, x2: px, y2: py, color: laneColor(row.lane) }];
    });
  });

  return (
    <svg width={width} height={Math.max(height, ROW_HEIGHT)} className="shrink-0">
      {edges.map((edge, index) => (
        <path
          key={index}
          d={`M ${edge.x1} ${edge.y1} C ${edge.x1} ${(edge.y1 + edge.y2) / 2}, ${edge.x2} ${(edge.y1 + edge.y2) / 2}, ${edge.x2} ${edge.y2}`}
          fill="none"
          stroke={edge.color}
          strokeWidth={2}
        />
      ))}
      {rows.map((row, index) => (
        <circle
          key={row.commit.hash}
          cx={row.lane * LANE_WIDTH + LANE_WIDTH / 2}
          cy={index * ROW_HEIGHT + ROW_HEIGHT / 2}
          r={row.commit.hash === UNCOMMITTED ? 4 : 5}
          fill={row.commit.hash === UNCOMMITTED ? "var(--foreground)" : laneColor(row.lane)}
          stroke="var(--background)"
          strokeWidth={2}
        />
      ))}
    </svg>
  );
}

export function GitGraphPanel({ project, onClose }: { project: Project; onClose: () => void }) {
  const [notGit, setNotGit] = useState(false);
  const [branch, setBranch] = useState<string | null>(null);
  const [dirty, setDirty] = useState(0);
  const [refs, setRefs] = useState<Ref[]>([]);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [branchScope, setBranchScope] = useState<string | null>(null);
  const [filterText, setFilterText] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<Array<CommitFile | ChangedFile>>([]);
  const [selectedFile, setSelectedFile] = useState<{ path: string; untracked: boolean } | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .git(project.id)
      .then((snapshot) => {
        if (!snapshot.isGit) {
          setNotGit(true);
          return;
        }
        setBranch(snapshot.branch ?? null);
        setDirty(snapshot.dirty ?? 0);
      })
      .catch((cause: Error) => setError(cause.message));
    api
      .graphRefs(project.id)
      .then((result) => setRefs(result.refs))
      .catch((cause: Error) => setError(cause.message));
  }, [project.id]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .graphLog(project.id, { maxCount: PAGE_SIZE, skip: 0, ...(branchScope ? { ref: branchScope } : {}) })
      .then((page) => {
        setCommits(page.commits);
        setHasMore(page.hasMore);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, [project.id, branchScope]);

  const loadMore = () => {
    setLoading(true);
    api
      .graphLog(project.id, {
        maxCount: PAGE_SIZE,
        skip: commits.length,
        ...(branchScope ? { ref: branchScope } : {}),
      })
      .then((page) => {
        setCommits((current) => [...current, ...page.commits]);
        setHasMore(page.hasMore);
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  };

  const refsByCommit = useMemo(() => {
    const map = new Map<string, Ref[]>();
    for (const ref of refs) {
      const bucket = map.get(ref.commit) ?? [];
      bucket.push(ref);
      map.set(ref.commit, bucket);
    }
    return map;
  }, [refs]);

  const headHash = useMemo(() => {
    if (!branch) return commits[0]?.hash ?? null;
    return refs.find((ref) => ref.kind === "head" && ref.name === branch)?.commit ?? commits[0]?.hash ?? null;
  }, [refs, branch, commits]);

  const graphCommits = useMemo(() => withUncommitted(commits, headHash, dirty > 0), [commits, headHash, dirty]);
  const { rows } = useMemo(() => layoutGraph(graphCommits), [graphCommits]);

  const needle = filterText.trim().toLowerCase();
  const visibleRows = needle
    ? rows.filter(
        (row) =>
          row.commit.message.toLowerCase().includes(needle) ||
          row.commit.authorName.toLowerCase().includes(needle) ||
          row.commit.hash.startsWith(needle),
      )
    : rows;

  const selectCommit = (hash: string) => {
    setSelected(hash);
    setSelectedFile(null);
    setDiff(null);
    if (hash === UNCOMMITTED) {
      api
        .projectChanges(project.id)
        .then((result) => setFiles(result.files))
        .catch((cause: Error) => setError(cause.message));
    } else {
      api
        .commitFiles(project.id, hash)
        .then((result) => setFiles(result.files))
        .catch((cause: Error) => setError(cause.message));
    }
  };

  const selectFile = (path: string, untracked: boolean) => {
    setSelectedFile({ path, untracked });
    setDiff(null);
    const request =
      selected === UNCOMMITTED
        ? api.projectFileDiff(project.id, path, untracked)
        : api.commitFileDiff(project.id, selected!, path);
    request.then((result) => setDiff(result.diff)).catch((cause: Error) => setError(cause.message));
  };

  if (notGit) {
    return (
      <Dialog title={`${project.name} · history`} onClose={onClose}>
        <p className="text-sm text-muted-foreground">This folder is not a git repository.</p>
      </Dialog>
    );
  }

  return (
    <Dialog title={`${project.name} · history`} onClose={onClose} wide>
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}

      <div className="mb-3 flex items-center gap-2">
        <Input
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
          placeholder="Filter by message, author, or hash"
          spellCheck={false}
          className="h-8 flex-1 font-mono text-xs"
        />
        <select
          value={branchScope ?? ""}
          onChange={(event) => setBranchScope(event.target.value || null)}
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
        >
          <option value="">All branches</option>
          {refs
            .filter((ref) => ref.kind === "head")
            .map((ref) => (
              <option key={ref.name} value={ref.name}>
                {ref.name}
              </option>
            ))}
        </select>
      </div>

      <div className="flex gap-3">
        <ScrollArea className="h-[50vh] flex-1 rounded-lg border border-border">
          <div className="flex">
            <div className="shrink-0 py-1 pl-2">
              <Graph rows={visibleRows} />
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Message</TableHead>
                  <TableHead>Author</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => (
                  <TableRow
                    key={row.commit.hash}
                    data-state={selected === row.commit.hash ? "selected" : undefined}
                    className="cursor-pointer"
                    onClick={() => selectCommit(row.commit.hash)}
                  >
                    <TableCell className="max-w-80 truncate">
                      <span className="flex items-center gap-1.5">
                        {(refsByCommit.get(row.commit.hash) ?? []).map((ref) => (
                          <Pill key={`${ref.kind}:${ref.name}`}>{ref.name}</Pill>
                        ))}
                        {row.commit.message}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{row.commit.authorName}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.commit.authorDate
                        ? new Date(row.commit.authorDate * 1000).toLocaleDateString()
                        : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {hasMore && !needle ? (
            <div className="p-2">
              <Button variant="outline" disabled={loading} onClick={loadMore} className="w-full">
                Load more
              </Button>
            </div>
          ) : null}
        </ScrollArea>

        <div className="w-64 shrink-0 rounded-lg border border-border p-2">
          {!selected ? (
            <p className="text-xs text-faint">Select a commit to see its changed files.</p>
          ) : (
            <ul className="space-y-0.5">
              {files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => selectFile(file.path, file.status === "untracked")}
                    className={cn(
                      "w-full truncate rounded-md px-1.5 py-0.5 text-left font-mono text-[11px] hover:bg-accent",
                      selectedFile?.path === file.path && "bg-accent",
                    )}
                  >
                    {file.path}
                  </button>
                </li>
              ))}
              {files.length === 0 ? <p className="text-xs text-faint">No changed files.</p> : null}
            </ul>
          )}
        </div>
      </div>

      {diff !== null ? (
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg border border-border bg-background p-2 font-mono text-[11px]">
          {diff || "No differences."}
        </pre>
      ) : null}
    </Dialog>
  );
}
