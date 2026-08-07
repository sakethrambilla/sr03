import { useEffect } from "react";
import { toast } from "sonner";

import { connectEvents } from "./lib/ws.ts";
import { useActiveThread, useStore } from "./store.ts";
import { ChatView } from "./components/ChatView.tsx";
import { DraftView } from "./components/DraftView.tsx";
import { Sidebar, SidebarToggle } from "./components/Sidebar.tsx";
import { SettingsView } from "./components/SettingsView.tsx";
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
  const settingsOpen = useStore((state) => state.settingsOpen);
  const toggleSidebar = useStore((state) => state.toggleSidebar);
  const thread = useActiveThread();

  useEffect(() => {
    void bootstrap();
    return connectEvents({ onEvent: applyEvent, onConnected: setConnected });
  }, [applyEvent, bootstrap, setConnected]);

  // the sidebar lives in the store, so its shortcut works even with nothing open
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.key.toLowerCase() !== "b") return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [toggleSidebar]);

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
      {settingsOpen ? (
        <SettingsView />
      ) : draft ? (
        <DraftView draft={draft} />
      ) : thread ? (
        <ChatView key={thread.id} thread={thread} />
      ) : (
        <main className="flex h-full min-w-0 flex-1 flex-col">
          <header data-titlebar className="flex h-15 shrink-0 items-center gap-2.5 border-b border-border/60 px-5">
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
