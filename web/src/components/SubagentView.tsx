// Tab body for one subagent: Claude gets the same Timeline the parent uses, scoped to that
// task; Cursor gets a card, because its protocol never publishes a child stream.
import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { FileLinks } from "../lib/fileref.ts";
import type { Thread, ThreadTask } from "../lib/types.ts";
import { EMPTY_PROVIDER, useStore } from "../store.ts";
import { Timeline } from "./Timeline.tsx";
import { Button } from "@/components/ui/button";
import { StopIcon } from "./ui.tsx";

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

function CursorCard({ task, now }: { task: ThreadTask; now: number }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 px-5 py-8">
      <p className="text-[14px] text-foreground">{task.description}</p>
      <p className="font-mono text-[10.5px] text-faint">
        {[
          task.agentType,
          task.model,
          task.status,
          formatDuration((task.endedAt ?? now) - task.startedAt),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Cursor reports that a subagent ran, but does not publish what it did. Its result is folded
        into the reply above.
      </p>
    </div>
  );
}

export function SubagentView({
  thread,
  taskId,
  files,
  onRun,
}: {
  thread: Thread;
  taskId: string;
  files: FileLinks;
  onRun: (command: string) => void;
}) {
  const tasks = useStore((state) => state.tasksByThread[thread.id] ?? NO_TASKS);
  const task = tasks.find((entry) => entry.id === taskId);
  const setError = useStore((state) => state.setError);
  const provider = useStore(
    (state) => state.providers.find((entry) => entry.id === thread.providerId) ?? EMPTY_PROVIDER,
  );
  const stale = task !== undefined && task.status === "running" && thread.status !== "running";
  const now = useClock(task?.status === "running" && !stale);

  if (!task) {
    return (
      <p className="px-5 py-8 text-[13px] text-faint">This subagent is no longer tracked.</p>
    );
  }

  const stop = () =>
    api.stopTask(thread.id, taskId).catch((error: Error) => setError(error.message));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-col gap-0.5 border-b border-border/60 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[13px]" title={task.description}>
            {task.description}
          </h2>
          {task.status === "stopped" ? (
            <span className="shrink-0 font-mono text-[10.5px] text-faint">stopped</span>
          ) : null}
          {task.status === "failed" ? (
            <span className="shrink-0 font-mono text-[10.5px] text-destructive">failed</span>
          ) : null}
          {stale ? (
            <span className="shrink-0 font-mono text-[10.5px] text-faint">no longer live</span>
          ) : null}
          {task.status === "running" && !stale && provider.capabilities.stopSubagents ? (
            <Button
              variant="outline"
              size="icon"
              onClick={() => void stop()}
              aria-label="Stop subagent"
              className="size-7 shrink-0"
            >
              <StopIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10.5px] text-faint">
          {task.agentType ? <span className="text-muted-foreground">{task.agentType}</span> : null}
          {task.model ? <span>{task.model}</span> : null}
          <span>{formatDuration((task.endedAt ?? now) - task.startedAt)}</span>
          <span>{formatTokens(task.tokens)}</span>
          <span>
            {task.toolUses} {task.toolUses === 1 ? "tool" : "tools"}
          </span>
        </div>
        {task.error ? <p className="text-[12px] text-destructive">{task.error}</p> : null}
      </header>
      {provider.capabilities.subagentTranscripts ? (
        <Timeline
          threadId={thread.id}
          taskId={taskId}
          running={task.status === "running"}
          files={files}
          onRun={onRun}
        />
      ) : (
        <CursorCard task={task} now={now} />
      )}
    </div>
  );
}
