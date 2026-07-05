import { create } from "zustand";

import { api } from "./lib/api.ts";
import type {
  AppState,
  Message,
  PendingApproval,
  PermissionMode,
  ServerEvent,
  Thread,
} from "./lib/types.ts";

interface Store extends AppState {
  connected: boolean;
  activeThreadId: string | null;
  messagesByThread: Record<string, Message[]>;
  streamByThread: Record<string, string>;
  approvalsByThread: Record<string, PendingApproval[]>;
  error: string | null;

  bootstrap: () => Promise<void>;
  refreshState: () => Promise<void>;
  openThread: (id: string) => Promise<void>;
  newThread: (input: { projectId: string; cwd?: string }) => Promise<void>;
  removeThread: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  patchActive: (patch: { model?: string; permissionMode?: PermissionMode }) => Promise<void>;
  respond: (approvalId: string, decision: "allow" | "always" | "deny") => Promise<void>;
  applyEvent: (event: ServerEvent) => void;
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
}

const EMPTY: AppState = {
  projects: [],
  threads: [],
  models: [],
  permissionModes: [],
  defaults: { model: "", permissionMode: "default" },
};

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  const next = threads.filter((item) => item.id !== thread.id);
  next.unshift(thread);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const useStore = create<Store>((set, get) => ({
  ...EMPTY,
  connected: false,
  activeThreadId: null,
  messagesByThread: {},
  streamByThread: {},
  approvalsByThread: {},
  error: null,

  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),

  bootstrap: async () => {
    await get().refreshState();
    const { threads, activeThreadId } = get();
    const next = activeThreadId ?? threads[0]?.id ?? null;
    if (next) await get().openThread(next);
  },

  refreshState: async () => {
    try {
      set(await api.state());
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  openThread: async (id) => {
    set({ activeThreadId: id });
    try {
      const { thread, messages } = await api.thread(id);
      set((state) => ({
        threads: upsertThread(state.threads, thread),
        messagesByThread: { ...state.messagesByThread, [id]: messages },
      }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  newThread: async ({ projectId, cwd }) => {
    const { defaults } = get();
    try {
      const thread = await api.createThread({
        projectId,
        ...(cwd ? { cwd } : {}),
        model: defaults.model,
        permissionMode: defaults.permissionMode,
      });
      set((state) => ({
        threads: upsertThread(state.threads, thread),
        activeThreadId: thread.id,
        messagesByThread: { ...state.messagesByThread, [thread.id]: [] },
      }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  removeThread: async (id) => {
    await api.removeThread(id).catch((error: Error) => set({ error: error.message }));
    set((state) => {
      const threads = state.threads.filter((thread) => thread.id !== id);
      return {
        threads,
        activeThreadId: state.activeThreadId === id ? (threads[0]?.id ?? null) : state.activeThreadId,
      };
    });
  },

  send: async (text) => {
    const id = get().activeThreadId;
    if (!id) return;
    try {
      await api.sendTurn(id, text);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  interrupt: async () => {
    const id = get().activeThreadId;
    if (id) await api.interrupt(id).catch(() => undefined);
  },

  patchActive: async (patch) => {
    const id = get().activeThreadId;
    if (!id) return;
    try {
      const thread = await api.patchThread(id, patch);
      set((state) => ({ threads: upsertThread(state.threads, thread) }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  respond: async (approvalId, decision) => {
    const id = get().activeThreadId;
    if (!id) return;
    set((state) => ({
      approvalsByThread: {
        ...state.approvalsByThread,
        [id]: (state.approvalsByThread[id] ?? []).filter((approval) => approval.id !== approvalId),
      },
    }));
    await api.respondToApproval(id, approvalId, decision).catch((error: Error) =>
      set({ error: error.message }),
    );
  },

  applyEvent: (event) => {
    switch (event.type) {
      case "thread.message": {
        set((state) => ({
          messagesByThread: {
            ...state.messagesByThread,
            [event.threadId]: [...(state.messagesByThread[event.threadId] ?? []), event.message],
          },
          streamByThread: { ...state.streamByThread, [event.threadId]: "" },
        }));
        return;
      }
      case "thread.delta": {
        set((state) => ({
          streamByThread: {
            ...state.streamByThread,
            [event.threadId]: (state.streamByThread[event.threadId] ?? "") + event.text,
          },
        }));
        return;
      }
      case "thread.delta.end": {
        set((state) => ({
          streamByThread: { ...state.streamByThread, [event.threadId]: "" },
        }));
        return;
      }
      case "thread.status": {
        set((state) => ({
          threads: state.threads.map((thread) =>
            thread.id === event.threadId
              ? {
                  ...thread,
                  status: event.status,
                  sessionId: event.sessionId ?? thread.sessionId,
                  updatedAt: Date.now(),
                }
              : thread,
          ),
        }));
        return;
      }
      case "thread.updated": {
        set((state) => ({ threads: upsertThread(state.threads, event.thread) }));
        return;
      }
      case "thread.approval": {
        set((state) => ({
          approvalsByThread: {
            ...state.approvalsByThread,
            [event.approval.threadId]: [
              ...(state.approvalsByThread[event.approval.threadId] ?? []),
              event.approval,
            ],
          },
        }));
        return;
      }
      case "thread.approval.resolved": {
        set((state) => ({
          approvalsByThread: {
            ...state.approvalsByThread,
            [event.threadId]: (state.approvalsByThread[event.threadId] ?? []).filter(
              (approval) => approval.id !== event.approvalId,
            ),
          },
        }));
        return;
      }
      case "projects.changed": {
        void get().refreshState();
        return;
      }
    }
  },
}));

export function useActiveThread(): Thread | null {
  return useStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId) ?? null);
}
