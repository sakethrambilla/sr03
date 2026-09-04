// The single client store, and the only place server state lives. `applyEvent` folds every
// socket event into it; every other action is a REST call plus the local update. Also holds the
// per-thread caches (messages, streaming text, approvals, subagents) and the streaming buffer
// that lets a reply out a slice per frame instead of in paragraph-sized lumps.
import { create } from "zustand";

import { api } from "./lib/api.ts";
import { applyAppearance, loadAppearance, saveAppearance } from "./lib/appearance.ts";
import type { Appearance } from "./lib/appearance.ts";
import type {
  AppState,
  Branch,
  Effort,
  GitSnapshot,
  Message,
  PendingApproval,
  PermissionMode,
  Resources,
  ServerEvent,
  SlashCommand,
  Thread,
  ThreadPhase,
  ThreadTask,
  Usage,
} from "./lib/types.ts";

export interface Draft {
  projectId: string | null;
  branch: string | null;
  createBranch: boolean;
  // set only by the worktree panel, meaning "run in this one"; a branch pick clears it
  worktreePath: string | null;
  worktree: boolean;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
}

// What the draft's branch + worktree pair will actually do on send. `folder` with no checkout runs
// in the project folder as it stands; a ticked worktree always branches, so it can never conflict.
export type DraftPlan =
  | { kind: "folder"; checkout: { branch: string; createBranch: boolean } | null }
  | { kind: "worktree"; branch: string; base: string | null }
  | { kind: "here"; path: string }
  | { kind: "blocked"; reason: string };

function unusedBranch(base: string, branches: Branch[]): string {
  const taken = new Set(branches.map((branch) => branch.name));
  let name = `${base}-wt`;
  let counter = 2;
  while (taken.has(name)) name = `${base}-wt${counter++}`;
  return name;
}

export function resolvePlan(draft: Draft, snapshot: GitSnapshot | null): DraftPlan {
  if (draft.worktree && draft.worktreePath) return { kind: "here", path: draft.worktreePath };

  const current = snapshot?.branch ?? null;
  const branches = snapshot?.branches ?? [];
  const selected = draft.branch ?? current;

  if (draft.worktree) {
    if (!selected) return { kind: "blocked", reason: "Pick a branch to base the worktree on" };
    // a name typed into the picker doesn't exist yet, so it becomes the worktree's own branch
    if (draft.createBranch) return { kind: "worktree", branch: selected, base: null };
    return { kind: "worktree", branch: unusedBranch(selected, branches), base: selected };
  }

  if (!selected || (selected === current && !draft.createBranch)) {
    return { kind: "folder", checkout: null };
  }
  if (!draft.createBranch) {
    const held = branches.find((branch) => branch.name === selected)?.worktreePath;
    if (held && held !== snapshot?.root) {
      return { kind: "blocked", reason: `${selected} is checked out in a worktree — tick worktree instead` };
    }
    // `switch -c` carries uncommitted work onto the new branch, but switching to an existing one
    // can drag it across unrelated commits
    const dirty = snapshot?.dirty ?? 0;
    if (dirty > 0) {
      return {
        kind: "blocked",
        reason: `The folder has ${dirty} uncommitted change${dirty === 1 ? "" : "s"} — commit them or tick worktree`,
      };
    }
  }
  return { kind: "folder", checkout: { branch: selected, createBranch: draft.createBranch } };
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
  // what a running turn is waiting on, for the label under the transcript
  phaseByThread: Record<string, ThreadPhase | null>;
  // bumped a moment after a turn writes to disk or ends, so the panels showing the folder
  // re-read once per burst of tool calls instead of once per call
  fsVersionByThread: Record<string, number>;
  // set once a thread's own messages have been read, so "no messages yet" and "not read yet"
  // don't render the same empty state
  loadedThreads: Record<string, true>;
  // slash commands belong to the folder, not the session — every thread in one shares a list
  commandsByCwd: Record<string, SlashCommand[]>;
  // every file in the folder, so a path a message mentions can be recognised as one
  filesByCwd: Record<string, string[]>;
  usage: Usage | null;
  // sampled by the server only while the meter is open, so it is null the rest of the time
  resources: Resources | null;
  appearance: Appearance;
  // threads whose turn ended while you were somewhere else, cleared when you open them
  finished: Record<string, true>;
  error: string | null;
  // false until the first bootstrap resolves, so the empty state never flashes before it
  booted: boolean;

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
  resync: () => Promise<void>;
  loadCommands: (cwd: string) => Promise<void>;
  loadFiles: (threadId: string, cwd: string) => Promise<void>;
  setAppearance: (patch: Partial<Appearance>) => void;
  restoreAppearance: () => Promise<void>;
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

// only these tools change the folder; a Read or a Grep never earns a re-read
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
const FS_SETTLE_MS = 750;
const fsTimers = new Map<string, number>();

function writes(message: Message): boolean {
  return message.role === "tool" && WRITE_TOOLS.has(String(message.meta?.toolName ?? ""));
}

function bumpFs(threadId: string, set: (partial: (state: Store) => Partial<Store>) => void): void {
  const pending = fsTimers.get(threadId);
  if (pending) window.clearTimeout(pending);
  fsTimers.set(
    threadId,
    window.setTimeout(() => {
      fsTimers.delete(threadId);
      set((state) => ({
        fsVersionByThread: {
          ...state.fsVersionByThread,
          [threadId]: (state.fsVersionByThread[threadId] ?? 0) + 1,
        },
      }));
    }, FS_SETTLE_MS),
  );
}

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  const next = threads.filter((item) => item.id !== thread.id);
  next.unshift(thread);
  return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

const APPEARANCE_KEY = "appearance";

// applied as the module loads rather than from an effect, so the first paint is already themed
const startingAppearance = loadAppearance();
applyAppearance(startingAppearance);

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
  phaseByThread: {},
  fsVersionByThread: {},
  loadedThreads: {},
  commandsByCwd: {},
  filesByCwd: {},
  usage: null,
  resources: null,
  appearance: startingAppearance,
  finished: loadFinished(),
  error: null,
  booted: false,

  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setConnected: (connected) => set({ connected }),
  setError: (error) => set({ error }),

  // localStorage is what paints the first frame; the server is what survives the desktop
  // shell's next launch, since that arrives on a different port with empty browser storage
  setAppearance: (patch) => {
    const appearance = { ...get().appearance, ...patch };
    applyAppearance(appearance);
    set({ appearance: saveAppearance(appearance) });
    void api.saveSetting(APPEARANCE_KEY, JSON.stringify(appearance)).catch(() => undefined);
  },

  bootstrap: async () => {
    await Promise.all([get().restoreAppearance(), get().refreshState()]);
    const { threads, activeThreadId } = get();
    const next = activeThreadId ?? threads[0]?.id ?? null;
    if (next) await get().openThread(next);
    else get().startDraft();
    set({ booted: true });
  },

  // a reconnect after any real gap (sleep, a server restart) may have missed events, so the
  // thread list and the open thread's own data are re-read rather than trusted as still current
  resync: async () => {
    await get().refreshState();
    const id = get().activeThreadId;
    if (!id) return;
    try {
      const { thread, messages: list, tasks } = await api.thread(id);
      set((state) => ({
        threads: upsertThread(state.threads, thread),
        messagesByThread: { ...state.messagesByThread, [id]: list },
        tasksByThread: { ...state.tasksByThread, [id]: tasks },
        loadedThreads: { ...state.loadedThreads, [id]: true },
      }));
      void get().refreshUsage();
    } catch (error) {
      set({ error: (error as Error).message });
    }
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
      // settings is a page beside the sessions, not a layer over them: picking one leaves it
      return {
        activeThreadId: id,
        draft: null,
        settingsOpen: false,
        finished: saveFinished(finished),
      };
    });
    try {
      const { thread, messages, tasks } = await api.thread(id);
      set((state) => ({
        threads: upsertThread(state.threads, thread),
        messagesByThread: { ...state.messagesByThread, [id]: messages },
        tasksByThread: { ...state.tasksByThread, [id]: tasks },
        loadedThreads: { ...state.loadedThreads, [id]: true },
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
      settingsOpen: false,
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

  // a thread only exists once its first turn is sent, so cwd/branch are fixed for its lifetime.
  // the draft may have sat open while branches moved, so the plan is resolved again here
  startFromDraft: async (text) => {
    const draft = get().draft;
    if (!draft?.projectId) throw new Error("Choose a folder first");
    const snapshot = await api.git(draft.projectId).catch(() => null);
    const plan = resolvePlan(draft, snapshot);
    if (plan.kind === "blocked") throw new Error(plan.reason);

    let cwd: string | undefined;
    if (plan.kind === "here") cwd = plan.path;
    if (plan.kind === "worktree") {
      const worktree = await api.addWorktree(draft.projectId, {
        branch: plan.branch,
        createBranch: true,
        ...(plan.base ? { base: plan.base } : {}),
      });
      cwd = worktree.path;
      void get().refreshState();
    }
    if (plan.kind === "folder" && plan.checkout) {
      await api.checkout(draft.projectId, plan.checkout);
      void get().refreshState();
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
      loadedThreads: { ...state.loadedThreads, [thread.id]: true },
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

  restoreAppearance: async () => {
    const stored = await api.settings().then(
      (body) => body.settings[APPEARANCE_KEY],
      () => undefined,
    );
    if (!stored) return;
    try {
      get().setAppearance(JSON.parse(stored) as Partial<Appearance>);
    } catch {
      // a value we can't read is a value we leave alone
    }
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
      case "thread.message.updated": {
        if (writes(event.message)) bumpFs(event.threadId, set);
        set((state) => ({
          messagesByThread: {
            ...state.messagesByThread,
            [event.threadId]: (state.messagesByThread[event.threadId] ?? []).map((message) =>
              message.id === event.message.id ? event.message : message,
            ),
          },
        }));
        return;
      }
      case "thread.phase": {
        set((state) => ({ phaseByThread: { ...state.phaseByThread, [event.threadId]: event.phase } }));
        return;
      }
      case "thread.truncated": {
        buffered.delete(event.threadId);
        set((state) => ({
          messagesByThread: {
            ...state.messagesByThread,
            [event.threadId]: (state.messagesByThread[event.threadId] ?? []).filter(
              (message) => message.seq < event.seq,
            ),
          },
          streamByThread: { ...state.streamByThread, [event.threadId]: "" },
          tasksByThread: { ...state.tasksByThread, [event.threadId]: [] },
          approvalsByThread: { ...state.approvalsByThread, [event.threadId]: [] },
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
        if (event.status !== "running") bumpFs(event.threadId, set);
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
      case "models.changed": {
        set({ models: event.models });
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
      case "resources": {
        set({ resources: event.resources });
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
