import { create } from "zustand";

import { api } from "./lib/api.ts";
import type {
  AppState,
  Effort,
  Message,
  PendingApproval,
  PermissionMode,
  ServerEvent,
  SlashCommand,
  Thread,
  ThreadTask,
  Usage,
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
  tasksByThread: Record<string, ThreadTask[]>;
  // slash commands belong to the folder, not the session — every thread in one shares a list
  commandsByCwd: Record<string, SlashCommand[]>;
  // every file in the folder, so a path a message mentions can be recognised as one
  filesByCwd: Record<string, string[]>;
  usage: Usage | null;
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
  refreshUsage: () => Promise<void>;
  loadCommands: (cwd: string) => Promise<void>;
  loadFiles: (threadId: string, cwd: string) => Promise<void>;
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

// the finished markers outlive a reload, so a session that ended while the app was
// closed still asks for attention when you come back
const FINISHED_KEY = "sr03:finished";

function loadFinished(): Record<string, true> {
  try {
    const stored = localStorage.getItem(FINISHED_KEY);
    return stored ? (JSON.parse(stored) as Record<string, true>) : {};
  } catch {
    return {};
  }
}

function saveFinished(finished: Record<string, true>): Record<string, true> {
  try {
    localStorage.setItem(FINISHED_KEY, JSON.stringify(finished));
  } catch {
    // private browsing, or the quota is gone — the markers just stop persisting
  }
  return finished;
}

// the agent SDK hands over whole paragraphs at a time — roughly 135 characters, once or twice
// a second — so text is buffered and let out a slice per frame instead of landing in lumps
const buffered = new Map<string, string>();
let frame: number | null = null;

// a sixth of what is waiting, so a backlog drains fast while a trickle still reads as typing
function slice(text: string): number {
  return Math.min(text.length, Math.max(2, Math.ceil(text.length / 6)));
}

// a hidden tab gets no animation frames at all, and the stream would sit unrendered until the
// turn ended — so the reveal falls back to a timer whenever the page is not being painted
function nextFrame(run: () => void): number {
  if (document.visibilityState === "hidden") return window.setTimeout(run, 16);
  return requestAnimationFrame(run);
}

function drain(set: (partial: (state: Store) => Partial<Store>) => void): void {
  if (frame !== null) return;
  frame = nextFrame(() => {
    frame = null;
    const reveal: Array<[string, string]> = [];
    for (const [threadId, text] of buffered) {
      const take = slice(text);
      reveal.push([threadId, text.slice(0, take)]);
      if (take < text.length) buffered.set(threadId, text.slice(take));
      else buffered.delete(threadId);
    }
    if (reveal.length > 0) {
      set((state) => {
        const streamByThread = { ...state.streamByThread };
        for (const [threadId, text] of reveal) {
          streamByThread[threadId] = (streamByThread[threadId] ?? "") + text;
        }
        return { streamByThread };
      });
    }
    if (buffered.size > 0) drain(set);
  });
}

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
  tasksByThread: {},
  commandsByCwd: {},
  filesByCwd: {},
  usage: null,
  finished: loadFinished(),
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
      const next = await api.state();
      const live = new Set(next.threads.map((thread) => thread.id));
      const finished = Object.fromEntries(
        Object.entries(get().finished).filter(([id]) => live.has(id)),
      ) as Record<string, true>;
      set({ ...next, finished: saveFinished(finished) });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  openThread: async (id) => {
    set((state) => {
      const finished = { ...state.finished };
      delete finished[id];
      return { activeThreadId: id, draft: null, finished: saveFinished(finished) };
    });
    try {
      const { thread, messages, tasks } = await api.thread(id);
      set((state) => ({
        threads: upsertThread(state.threads, thread),
        messagesByThread: { ...state.messagesByThread, [id]: messages },
        tasksByThread: { ...state.tasksByThread, [id]: tasks },
      }));
      void get().refreshUsage();
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

  // a cold read spawns a CLI of its own, so a folder is only ever asked once
  loadCommands: async (cwd) => {
    if (get().commandsByCwd[cwd]) return;
    const commands = await api.commands(cwd).then(
      (body) => body.commands,
      () => null,
    );
    if (commands) set((state) => ({ commandsByCwd: { ...state.commandsByCwd, [cwd]: commands } }));
  },

  // a turn can add or delete files, so this is re-read rather than cached for the session
  loadFiles: async (threadId, cwd) => {
    const files = await api.files(threadId).then(
      (body) => body.files,
      () => null,
    );
    if (files) set((state) => ({ filesByCwd: { ...state.filesByCwd, [cwd]: files } }));
  },

  // context is per-session and the plan windows are account-wide, so both come from one read
  refreshUsage: async () => {
    const usage = await api.usage(get().activeThreadId).catch(() => null);
    if (usage) set({ usage });
  },

  applyEvent: (event) => {
    switch (event.type) {
      case "thread.message": {
        buffered.delete(event.threadId);
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
        buffered.set(event.threadId, (buffered.get(event.threadId) ?? "") + event.text);
        drain(set);
        return;
      }
      case "thread.delta.end": {
        buffered.delete(event.threadId);
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
              ? saveFinished({ ...state.finished, [event.threadId]: true as const })
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
      case "usage": {
        if (event.threadId && event.threadId !== get().activeThreadId) return;
        set({ usage: event.usage });
        return;
      }
      case "thread.tasks": {
        set((state) => ({
          tasksByThread: { ...state.tasksByThread, [event.threadId]: event.tasks },
        }));
        return;
      }
      // the CLI re-sends the whole list whenever it changes, so this replaces rather than merges
      case "thread.commands": {
        const cwd = get().threads.find((thread) => thread.id === event.threadId)?.cwd;
        if (!cwd) return;
        set((state) => ({ commandsByCwd: { ...state.commandsByCwd, [cwd]: event.commands } }));
        return;
      }
      // the server is authoritative for what is still outstanding, so this replaces rather than merges
      case "thread.approvals": {
        const byThread: Record<string, PendingApproval[]> = {};
        for (const approval of event.approvals) {
          (byThread[approval.threadId] ??= []).push(approval);
        }
        set({ approvalsByThread: byThread });
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
