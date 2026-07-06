import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { ThreadComposer } from "./Composer.tsx";
import { SidebarToggle } from "./Sidebar.tsx";
import { Timeline } from "./Timeline.tsx";
import { Pill, StatusDot } from "./ui.tsx";
import type { Message } from "../lib/types.ts";

const NO_MESSAGES: Message[] = [];

function ThreadHeader({ thread }: { thread: Thread }) {
  const [dirty, setDirty] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const poll = () =>
      api
        .threadGit(thread.id)
        .then((snapshot) => {
          if (!cancelled) setDirty(snapshot.dirty);
        })
        .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [thread.id, thread.status]);

  return (
    <header className="flex items-center gap-3 border-b border-border px-5 py-3">
      <SidebarToggle />
      <StatusDot status={thread.status} />
      <h1 className="min-w-0 truncate text-sm font-medium">{thread.title}</h1>
      <div className="flex flex-wrap items-center gap-1.5">
        {thread.branch ? (
          <Pill className={thread.isWorktree ? "border-primary/50 text-primary" : undefined}>
            {thread.branch}
          </Pill>
        ) : null}
        {dirty ? <Pill>{dirty} changed</Pill> : null}
      </div>
      <div className="flex-1" />
      <span className="truncate font-mono text-[11px] text-faint" title={thread.cwd}>
        {thread.cwd.replace(/^\/Users\/[^/]+/, "~")}
      </span>
    </header>
  );
}

export function ChatView({ thread }: { thread: Thread }) {
  const messages = useStore((state) => state.messagesByThread[thread.id] ?? NO_MESSAGES);
  const streaming = useStore((state) => state.streamByThread[thread.id] ?? "");

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <ThreadHeader thread={thread} />
      <Timeline messages={messages} streaming={streaming} running={thread.status === "running"} />
      <ThreadComposer thread={thread} />
    </main>
  );
}
