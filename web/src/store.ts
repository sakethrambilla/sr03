import { create } from "zustand";

import { api } from "./lib/api.ts";
import type {
  AppState,
  Effort,
  Message,
  PendingApproval,
  PermissionMode,
  ServerEvent,
  Thread,
} from "./lib/types.ts";

export interface Draft {
  projectId: string | null;
  branch: string | null;
  createBranch: boolean;
  worktreePath: string | null;
  worktree: boolean;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
}

interface Store extends AppState {
  connected: boolean;
  sidebarOpen: boolean;
  settingsOpen: boolean;
  activeThreadId: string | null;
  draft: Draft | null;
  messagesByThread: Record<string, Message[]>;
  streamByThread: Record<string, string>;
  approvalsByThread: Record<string, PendingApproval[]>;
  // threads whose turn ended while you were somewhere else, cleared when you open them
  finished: Record<string, true>;
  error: string | null;

  bootstrap: () => Promise<void>;
  refreshState: () => Promise<void>;
  openThread: (id: string) => Promise<void>;
  startDraft: (input?: { projectId?: string; branch?: string; worktreePath?: string }) => void;
  patchDraft: (patch: Partial<Draft>) => void;
  startFromDraft: (text: string) => Promise<void>;
  renameThread: (id: string, title: string) => Promise<void>;
  forkThread: (id: string) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  removeThread: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  patchActive: (patch: { model?: string; permissionMode?: PermissionMode; effort?: Effort }) => Promise<void>;
  respond: (approvalId: string, decision: "allow" | "always" | "deny") => Promise<void>;
  applyEvent: (event: ServerEvent) => void;
  toggleSidebar: () => void;
  setSettingsOpen: (open: boolean) => void;
  setConnected: (connected: boolean) => void;
  setError: (error: string | null) => void;
}

const EMPTY: AppState = {
  projects: [],
  threads: [],
  models: [],
  permissionModes: [],
  effortLevels: [],
  apps: [],
  defaults: { model: "", permissionMode: "default", effort: "high" },
};

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  const next = threads.filter((item) => item.id !== thread.id);
  next.unshift(thread);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export const useStore = create<Store>((set, get) => ({
  ...EMPTY,
  connected: false,
  sidebarOpen: true,
  settingsOpen: false,
  activeThreadId: null,
  draft: null,
  messagesByThread: {},
  streamByThread: {},
  approvalsByThread: {},
  finished: {},
  error: null,

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),

  bootstrap: async () => {
    await get().refreshState();
    const { threads, activeThreadId } = get();
    const next = activeThreadId ?? threads[0]?.id ?? null;
    if (next) await get().openThread(next);
    else get().startDraft();
  },

  refreshState: async () => {
    try {
      set(await api.state());
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  openThread: async (id) => {
    set((state) => {
      const finished = { ...state.finished };
      delete finished[id];
      return { activeThreadId: id, draft: null, finished };
    });
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

  startDraft: (input) => {
    const { defaults } = get();
    set({
      activeThreadId: null,
      draft: {
        projectId: input?.projectId ?? null,
        branch: input?.branch ?? null,
        createBranch: false,
        worktreePath: input?.worktreePath ?? null,
        worktree: Boolean(input?.worktreePath),
        model: defaults.model,
        permissionMode: defaults.permissionMode,
        effort: defaults.effort,
      },
    });
  },

  patchDraft: (patch) =>
    set((state) => (state.draft ? { draft: { ...state.draft, ...patch } } : {})),

  // a thread only exists once its first turn is sent, so cwd/branch are fixed for its lifetime
  startFromDraft: async (text) => {
    const draft = get().draft;
    if (!draft?.projectId) throw new Error("Choose a folder first");
    let cwd = draft.worktreePath ?? undefined;
    if (!cwd && draft.worktree && draft.branch) {
      const worktree = await api.addWorktree(draft.projectId, {
        branch: draft.branch,
        createBranch: draft.createBranch,
      });
      cwd = worktree.path;
    }
    const thread = await api.createThread({
      projectId: draft.projectId,
      ...(cwd ? { cwd } : {}),
      model: draft.model,
      permissionMode: draft.permissionMode,
      effort: draft.effort,
    });
    set((state) => ({
      threads: upsertThread(state.threads, thread),
      activeThreadId: thread.id,
      messagesByThread: { ...state.messagesByThread, [thread.id]: [] },
      draft: null,
    }));
    await api.sendTurn(thread.id, text);
  },

  renameThread: async (id, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    try {
      const thread = await api.patchThread(id, { title: trimmed });
      set((state) => ({ threads: upsertThread(state.threads, thread) }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  forkThread: async (id) => {
    try {
      const thread = await api.forkThread(id);
      set((state) => ({ threads: upsertThread(state.threads, thread) }));
      await get().openThread(thread.id);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  setArchived: async (id, archived) => {
    try {
      const thread = await api.patchThread(id, { archived });
      set((state) => ({ threads: upsertThread(state.threads, thread) }));
      if (!archived || get().activeThreadId !== id) return;
      const next = get().threads.find((item) => item.id !== id && !item.archived);
      if (next) await get().openThread(next.id);
      else get().startDraft();
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

  // applied locally first so the pickers move with the pointer, not with the round trip
  patchActive: async (patch) => {
    const id = get().activeThreadId;
    if (!id) return;
    set((state) => ({
      threads: state.threads.map((thread) => (thread.id === id ? { ...thread, ...patch } : thread)),
    }));
    try {
      const thread = await api.patchThread(id, patch);
      set((state) => ({ threads: upsertThread(state.threads, thread) }));
    } catch (error) {
      set({ error: (error as Error).message });
      await get().refreshState();
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
          // a turn you watched finish needs no marker; one you missed does
          finished:
            state.threads.find((thread) => thread.id === event.threadId)?.status === "running" &&
            event.status === "idle" &&
            state.activeThreadId !== event.threadId
              ? { ...state.finished, [event.threadId]: true as const }
              : state.finished,
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
