// Tab body for a sibling agent opened from another thread's header: its own transcript and
// composer, acting on that thread rather than the active one.
import { useEffect, useState } from "react";

import type { FileLinks } from "../lib/fileref.ts";
import { useStore } from "../store.ts";
import { ThreadComposer } from "./Composer.tsx";
import { Timeline } from "./Timeline.tsx";

export function ThreadTabView({
  threadId,
  files,
  onRun,
}: {
  threadId: string;
  files: FileLinks;
  onRun: (command: string) => void;
}) {
  const thread = useStore((state) => state.threads.find((entry) => entry.id === threadId));
  const loaded = useStore((state) => Boolean(state.loadedThreads[threadId]));
  const loadThread = useStore((state) => state.loadThread);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loaded) return;
    loadThread(threadId).catch(() => setFailed(true));
  }, [threadId, loaded, loadThread]);

  if (!thread) {
    return failed || loaded ? (
      <p className="p-4 text-sm text-muted-foreground">This session no longer exists.</p>
    ) : null;
  }

  return (
    <>
      <Timeline threadId={thread.id} running={thread.status === "running"} files={files} onRun={onRun} />
      <ThreadComposer thread={thread} />
    </>
  );
}
