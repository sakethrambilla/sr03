import { useEffect } from "react";

import { connectEvents } from "./lib/ws.ts";
import { useActiveThread, useStore } from "./store.ts";
import { ChatView } from "./components/ChatView.tsx";
import { DraftView } from "./components/DraftView.tsx";
import { Sidebar, SidebarToggle } from "./components/Sidebar.tsx";
import { CloseIcon } from "./components/ui.tsx";

export function App() {
  const bootstrap = useStore((state) => state.bootstrap);
  const applyEvent = useStore((state) => state.applyEvent);
  const setConnected = useStore((state) => state.setConnected);
  const error = useStore((state) => state.error);
  const setError = useStore((state) => state.setError);
  const draft = useStore((state) => state.draft);
  const startDraft = useStore((state) => state.startDraft);
  const sidebarOpen = useStore((state) => state.sidebarOpen);
  const thread = useActiveThread();

  useEffect(() => {
    void bootstrap();
    return connectEvents({ onEvent: applyEvent, onConnected: setConnected });
  }, [applyEvent, bootstrap, setConnected]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      {sidebarOpen ? <Sidebar /> : null}
      {draft ? (
        <DraftView draft={draft} />
      ) : thread ? (
        <ChatView key={thread.id} thread={thread} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2.5 border-b border-border/60 px-5 py-3">
            <SidebarToggle />
          </header>
          <div className="flex flex-1 flex-col items-center justify-center text-center">
            <p className="text-[13px] text-muted-foreground">Nothing open</p>
            <button
              onClick={() => startDraft()}
              className="mt-2 h-8 rounded-md bg-accent/70 px-3 text-[13px] text-foreground transition hover:bg-accent"
            >
              + New session
            </button>
          </div>
        </main>
      )}
      {error ? (
        <div className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/15 px-3 py-2 text-xs text-destructive">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-destructive/70 hover:text-destructive">
            <CloseIcon />
          </button>
        </div>
      ) : null}
    </div>
  );
}
