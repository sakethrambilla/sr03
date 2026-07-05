import { useEffect } from "react";

import { connectEvents } from "./lib/ws.ts";
import { useActiveThread, useStore } from "./store.ts";
import { ChatView } from "./components/ChatView.tsx";
import { Sidebar } from "./components/Sidebar.tsx";

export function App() {
  const bootstrap = useStore((state) => state.bootstrap);
  const applyEvent = useStore((state) => state.applyEvent);
  const setConnected = useStore((state) => state.setConnected);
  const error = useStore((state) => state.error);
  const setError = useStore((state) => state.setError);
  const thread = useActiveThread();

  useEffect(() => {
    void bootstrap();
    return connectEvents({ onEvent: applyEvent, onConnected: setConnected });
  }, [applyEvent, bootstrap, setConnected]);

  return (
    <div className="flex h-full w-full overflow-hidden">
      <Sidebar />
      {thread ? (
        <ChatView key={thread.id} thread={thread} />
      ) : (
        <main className="flex flex-1 items-center justify-center">
          <div className="text-center">
            <p className="text-sm text-muted">No thread selected</p>
            <p className="mt-1 text-xs text-faint">Add a folder, then start a thread.</p>
          </div>
        </main>
      )}
      {error ? (
        <div className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-danger/50 bg-danger/15 px-3 py-2 text-xs text-danger">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-danger/70 hover:text-danger">
            ✕
          </button>
        </div>
      ) : null}
    </div>
  );
}
