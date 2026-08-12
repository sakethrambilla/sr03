import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

import { publish } from "./bus.ts";
import { liveThreads } from "./claude.ts";
import { threads as threadStore } from "./db.ts";
import { sessionPids } from "./pty.ts";
import type { ResourceGroup, Resources } from "./types.ts";

const run = promisify(execFile);

// the first reading is worth having quickly, after that a slower tick keeps `ps` off the CPU
// this is meant to measure
const FIRST_TICK = 500;
const TICK = 2000;

interface Proc {
  pid: number;
  ppid: number;
  rss: number;
  cpu: number;
}

interface Sample {
  at: number;
  rows: Map<number, Proc>;
}

// ps prints cumulative cpu time as [dd-]hh:mm:ss.ss
function seconds(time: string): number {
  return time.split(/[-:]/).reduce((total, part) => total * 60 + Number(part), 0);
}

async function sample(): Promise<Sample> {
  const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,rss=,time="], { maxBuffer: 8 << 20 });
  const rows = new Map<number, Proc>();
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    rows.set(pid, { pid, ppid: Number(match[2]), rss: Number(match[3]) * 1024, cpu: seconds(match[4]!) });
  }
  return { at: Date.now(), rows };
}

function childIndex(rows: Map<number, Proc>): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const proc of rows.values()) {
    const siblings = children.get(proc.ppid);
    if (siblings) siblings.push(proc.pid);
    else children.set(proc.ppid, [proc.pid]);
  }
  return children;
}

function subtree(children: Map<number, number[]>, root: number): number[] {
  const collected: number[] = [];
  const stack = [root];
  while (stack.length) {
    const pid = stack.pop()!;
    collected.push(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  return collected;
}

// the SDK never exposes the pid of the CLI it spawns, so a child is placed on a thread by the
// one thing the two share: the folder it runs in. pids are recycled, so the cache is pruned to
// what is still alive on every tick
const cwdByPid = new Map<number, string>();

async function resolveCwds(pids: number[]): Promise<void> {
  const unknown = pids.filter((pid) => !cwdByPid.has(pid));
  if (unknown.length === 0) return;
  let stdout = "";
  try {
    stdout = (await run("lsof", ["-a", "-p", unknown.join(","), "-d", "cwd", "-Fpn"])).stdout;
  } catch (error) {
    // lsof exits non-zero when any one of the pids has already gone, having printed the rest
    stdout = (error as { stdout?: string }).stdout ?? "";
  }
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid) cwdByPid.set(pid, line.slice(1));
  }
}

function usage(pids: number[], now: Sample, before: Sample): { rss: number; cpu: number; processes: number } {
  const elapsed = Math.max((now.at - before.at) / 1000, 0.001);
  let rss = 0;
  let cpu = 0;
  let processes = 0;
  for (const pid of pids) {
    const proc = now.rows.get(pid);
    if (!proc) continue;
    processes += 1;
    rss += proc.rss;
    const prior = before.rows.get(pid);
    if (prior) cpu += ((proc.cpu - prior.cpu) / elapsed) * 100;
  }
  return { rss, cpu: Math.max(cpu, 0), processes };
}

function build(now: Sample, before: Sample): Resources {
  const children = childIndex(now.rows);
  const shellPid = Number(process.env.SR03_SHELL_PID ?? 0) || null;
  const hasShell = Boolean(shellPid && now.rows.has(shellPid));
  const serverPids = subtree(children, process.pid);
  const rootPids = hasShell ? subtree(children, shellPid!) : serverPids;

  const terminals = new Map<number, string>();
  for (const { pid, threadId } of sessionPids()) terminals.set(pid, threadId);

  // only a session that is actually live can own an agent process, which narrows the folder
  // match enough that two threads on one folder rarely collide. lsof reports the kernel's own
  // path, so a thread's cwd has to be resolved too or nothing under a symlink ever matches
  const owners = new Map<string, string[]>();
  for (const threadId of liveThreads()) {
    const cwd = threadStore.byId(threadId)?.cwd;
    if (!cwd) continue;
    let real = cwd;
    try {
      real = fs.realpathSync(cwd);
    } catch {
      // the folder went away under a live session
    }
    const claimed = owners.get(real);
    if (claimed) claimed.push(threadId);
    else owners.set(real, [threadId]);
  }

  const groups = new Map<string, ResourceGroup>();
  const add = (id: string, title: string, kind: ResourceGroup["kind"], pids: number[]) => {
    const measured = usage(pids, now, before);
    const existing = groups.get(id);
    if (existing) {
      existing.rss += measured.rss;
      existing.cpu += measured.cpu;
      existing.processes += measured.processes;
      return;
    }
    groups.set(id, { id, title, kind, ...measured });
  };

  for (const pid of children.get(process.pid) ?? []) {
    const pids = subtree(children, pid);
    const terminal = terminals.get(pid);
    if (terminal) {
      add(`${terminal}:terminal`, threadStore.byId(terminal)?.title ?? "Terminal", "terminal", pids);
      continue;
    }
    const cwd = cwdByPid.get(pid);
    // shift claims the thread, so two live sessions on one folder land on separate rows
    const owner = cwd ? owners.get(cwd)?.shift() : undefined;
    if (!owner) {
      add("other", "Other", "other", pids);
      continue;
    }
    add(`${owner}:agent`, threadStore.byId(owner)?.title ?? "Agent", "agent", pids);
  }

  const memory = process.memoryUsage();
  const total = usage(rootPids, now, before);
  const server = usage([process.pid], now, before);
  const whole = usage(serverPids, now, before);

  return {
    at: now.at,
    total,
    server: {
      rss: server.rss,
      cpu: server.cpu,
      heapUsed: memory.heapUsed,
      external: memory.external + memory.arrayBuffers,
    },
    shell: !hasShell
      ? null
      : {
          rss: total.rss - whole.rss,
          cpu: Math.max(total.cpu - whole.cpu, 0),
          processes: total.processes - whole.processes,
        },
    groups: [...groups.values()].sort((left, right) => right.cpu - left.cpu || right.rss - left.rss),
  };
}

let watchers = 0;
let timer: NodeJS.Timeout | null = null;
let previous: Sample | null = null;
let latest: Resources | null = null;

async function tick(): Promise<void> {
  const now = await sample();
  for (const pid of cwdByPid.keys()) if (!now.rows.has(pid)) cwdByPid.delete(pid);
  // resolving only pids that survived a tick keeps the short-lived tool processes the server
  // spawns itself — git, mostly — from costing an lsof each
  if (previous) {
    const direct = (childIndex(now.rows).get(process.pid) ?? []).filter((pid) =>
      previous!.rows.has(pid),
    );
    await resolveCwds(direct);
    latest = build(now, previous);
    publish({ type: "resources", resources: latest });
  }
  previous = now;
}

function schedule(delay: number): void {
  timer = setTimeout(() => {
    void tick()
      .catch((error: Error) => console.error("[metrics]", error.message))
      .finally(() => {
        if (watchers > 0) schedule(TICK);
      });
  }, delay);
}

// sampling runs only while a client is looking at it, so an unopened meter costs nothing
export function watch(): () => void {
  watchers += 1;
  if (watchers === 1) {
    previous = null;
    schedule(FIRST_TICK);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    watchers -= 1;
    if (watchers > 0) return;
    if (timer) clearTimeout(timer);
    timer = null;
    previous = null;
    latest = null;
  };
}

export function snapshot(): Resources | null {
  return latest;
}
