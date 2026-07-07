import { useEffect } from "react";
import { toast } from "sonner";

import { connectEvents } from "./lib/ws.ts";
import { useActiveThread, useStore } from "./store.ts";
import { ChatView } from "./components/ChatView.tsx";
import { DraftView } from "./components/DraftView.tsx";
import { Sidebar, SidebarToggle } from "./components/Sidebar.tsx";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

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

  // the store carries one error at a time; sonner decides how long it stays on screen
  useEffect(() => {
    if (!error) return;
    toast.error(error);
    setError(null);
  }, [error, setError]);

  return (
    <TooltipProvider>
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
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <p className="text-[13px] text-muted-foreground">Nothing open</p>
            <Button variant="secondary" onClick={() => startDraft()}>
              New session
            </Button>
          </div>
        </main>
      )}
        <Toaster position="bottom-center" />
      </div>
    </TooltipProvider>
  );
}
