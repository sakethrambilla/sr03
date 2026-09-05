// The subagents the current turn spawned, one row each with its tool count, tokens and elapsed
// time. Server-side these live only in memory, so the panel is empty after a restart.
import { useEffect, useState } from "react";

import type { Thread, ThreadTask } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { CloseIcon, StatusDot, cn } from "./ui.tsx";

const NO_TASKS: ThreadTask[] = [];

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function formatTokens(total: number): string {
  if (total < 1000) return `${total} tok`;
  if (total < 100_000) return `${(total / 1000).toFixed(1)}k tok`;
  return `${Math.round(total / 1000)}k tok`;
}

// a running agent's elapsed time has to move on its own, since progress events are minutes apart
function useClock(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

function TaskRow({ task, now }: { task: ThreadTask; now: number }) {
  const trailer = task.error ?? task.lastTool;

  return (
    <div
      style={{ paddingLeft: 12 + (task.depth - 1) * 12 }}
      className="flex flex-col gap-0.5 py-1.5 pr-3"
    >
      <div className="flex items-center gap-2">
        <StatusDot
          status={task.status === "failed" ? "error" : task.status === "running" ? "running" : "idle"}
          done={task.status === "done"}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px]" title={task.description}>
          {task.description}
        </span>
        <span className="shrink-0 font-mono text-[10.5px] text-faint">
          {formatDuration((task.endedAt ?? now) - task.startedAt)}
        </span>
      </div>

      <div className="flex items-center gap-1.5 pl-[15px] font-mono text-[10.5px] text-faint">
        {task.agentType ? (
          <span className="max-w-24 truncate text-muted-foreground">{task.agentType}</span>
        ) : null}
        <span>{formatTokens(task.tokens)}</span>
        <span>· {task.toolUses} {task.toolUses === 1 ? "tool" : "tools"}</span>
      </div>

      {trailer ? (
        <p
          title={trailer}
          className={cn("truncate pl-[15px] text-[11px]", task.error ? "text-destructive" : "text-faint")}
        >
          {trailer}
        </p>
      ) : null}
    </div>
  );
}

export function AgentsPanel({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const tasks = useStore((state) => state.tasksByThread[thread.id] ?? NO_TASKS);
  const running = tasks.filter((task) => task.status === "running").length;
  const now = useClock(running > 0);
  const tokens = tasks.reduce((total, task) => total + task.tokens, 0);

  return (
    <aside className="flex h-full w-[260px] shrink-0 flex-col border-l border-border/60 bg-card">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <h2 className="shrink-0 text-[12px] font-semibold tracking-wide text-muted-foreground uppercase">
          Agents
        </h2>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose} aria-label="Close agents">
          <CloseIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {tasks.length === 0 ? (
          <p className="px-3 py-4 text-[12px] text-faint">
            Subagents this session spawns show up here while they work.
          </p>
        ) : (
          tasks.map((task) => <TaskRow key={task.id} task={task} now={now} />)
        )}
      </div>

      {tasks.length > 0 ? (
        <footer className="flex items-center gap-2 border-t border-border/60 px-3 py-2 font-mono text-[10.5px] text-faint">
          <StatusDot status={running > 0 ? "running" : "idle"} done={running === 0} />
          <span>{running > 0 ? `${running} working` : `${tasks.length} done`}</span>
          <div className="flex-1" />
          <span>{formatTokens(tokens)}</span>
        </footer>
      ) : null}
    </aside>
  );
}
