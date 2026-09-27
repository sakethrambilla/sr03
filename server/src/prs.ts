// Polls gh for the PR behind each worktree thread's branch, and archives the thread — removing its
// worktree and branch — once that PR merges.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { closeSession } from "./agents/runtime.ts";
import { publish } from "./bus.ts";
import { projects, threads } from "./db.ts";
import { findExecutable } from "./executables.ts";
import * as git from "./git.ts";
import type { PrState, Thread } from "./types.ts";

const exec = promisify(execFile);
const POLL_MS = 60_000;

type KnownPr = Exclude<PrState, "none">;
export type PrLister = (root: string, since: number) => Promise<Map<string, KnownPr> | null>;

interface GhPr {
  headRefName: string;
  headRepositoryOwner: { login: string } | null;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
}

export function parsePrList(json: string, owner: string, since: number): Map<string, KnownPr> {
  const latest = new Map<string, GhPr>();
  for (const pr of JSON.parse(json) as GhPr[]) {
    if (pr.headRepositoryOwner?.login !== owner || Date.parse(pr.createdAt) < since) continue;
    const seen = latest.get(pr.headRefName);
    if (!seen || Date.parse(pr.updatedAt) > Date.parse(seen.updatedAt)) latest.set(pr.headRefName, pr);
  }
  const result = new Map<string, KnownPr>();
  for (const [branch, pr] of latest) {
    if (pr.state === "MERGED") result.set(branch, "merged");
    else if (pr.state === "OPEN") result.set(branch, pr.isDraft ? "draft" : "open");
  }
  return result;
}

const logged = new Set<string>();
function logOnce(message: string): void {
  if (logged.has(message)) return;
  logged.add(message);
  console.warn("[prs]", message);
}

let gh: string | null | undefined;
const owners = new Map<string, string>();

async function ghListPrs(root: string, since: number): Promise<Map<string, KnownPr> | null> {
  if (gh === undefined) gh = await findExecutable(["gh"]);
  if (!gh) {
    logOnce("gh not found on PATH");
    return null;
  }
  try {
    let owner = owners.get(root);
    if (!owner) {
      const { stdout } = await exec(gh, ["repo", "view", "--json", "owner", "-q", ".owner.login"], { cwd: root });
      owner = stdout.trim();
      owners.set(root, owner);
    }
    const { stdout } = await exec(
      gh,
      ["pr", "list", "--state", "all", "--limit", "200", "--json", "headRefName,headRepositoryOwner,state,isDraft,createdAt,updatedAt"],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return parsePrList(stdout, owner, since);
  } catch (error) {
    logOnce((error as { stderr?: string }).stderr?.trim() || (error as Error).message);
    return null;
  }
}

const pendingArchive = new Set<string>();

async function finalizeMerged(thread: Thread): Promise<void> {
  const project = projects.byId(thread.projectId)!;
  threads.update(thread.id, { archived: true });
  publish({ type: "thread.updated", thread: threads.byId(thread.id)! });
  if (threads.list().some((other) => other.id !== thread.id && !other.archived && other.cwd === thread.cwd)) return;
  const root = (await git.repoInfo(project.path)).root!;
  if ((await git.changedFiles(thread.cwd)).length > 0) {
    console.warn("[prs] kept dirty worktree", thread.cwd);
    return;
  }
  closeSession(thread.id);
  await git.removeWorktree({ root, path: thread.cwd, force: false });
  await git.deleteBranch(root, thread.branch!);
  await git.pruneWorktrees(root);
  publish({ type: "projects.changed" });
}

export async function pollPrs(listPrs: PrLister = ghListPrs): Promise<void> {
  const candidates = threads.list().filter((thread) => thread.isWorktree && thread.branch && !thread.archived);
  if (candidates.length === 0) return;

  const byProject = new Map<string, Thread[]>();
  for (const thread of candidates) byProject.set(thread.projectId, [...(byProject.get(thread.projectId) ?? []), thread]);

  for (const [projectId, group] of byProject) {
    const root = projects.byId(projectId)!.path;
    const prs = await listPrs(root, Math.min(...group.map((thread) => thread.createdAt)));
    if (prs === null) continue;
    for (const thread of group) {
      try {
        const next = prs.get(thread.branch!) ?? "none";
        if (next === thread.pr) continue;
        threads.update(thread.id, { pr: next });
        publish({ type: "thread.updated", thread: threads.byId(thread.id)! });
        if (next !== "merged") continue;
        if (thread.status === "running") pendingArchive.add(thread.id);
        else await finalizeMerged(threads.byId(thread.id)!);
      } catch (error) {
        console.error("[prs]", thread.id, (error as Error).message);
      }
    }
  }

  for (const id of pendingArchive) {
    const thread = threads.byId(id);
    if (!thread || thread.archived) {
      pendingArchive.delete(id);
      continue;
    }
    if (thread.status === "running") continue;
    pendingArchive.delete(id);
    try {
      await finalizeMerged(thread);
    } catch (error) {
      console.error("[prs]", id, (error as Error).message);
    }
  }
}

export function startPrWatch(): void {
  const tick = () => {
    pollPrs()
      .catch((error: Error) => console.error("[prs]", error.message))
      .finally(() => setTimeout(tick, POLL_MS).unref());
  };
  tick();
}
