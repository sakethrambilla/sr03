// The single client store, and the only place server state lives. `applyEvent` folds every
// socket event into it; every other action is a REST call plus the local update. Also holds the
// per-thread caches (messages, streaming text, approvals, subagents) and the streaming buffer
// that lets a reply out a slice per frame instead of in paragraph-sized lumps.
import { create } from "zustand";

import { api } from "./lib/api.ts";
import { persistable } from "./lib/layout.ts";
import { applyAppearance, loadAppearance, saveAppearance, watchSystemMode } from "./lib/appearance.ts";
import type { Appearance } from "./lib/appearance.ts";
import type {
  AppState,
  ApprovalDecision,
  Branch,
  EditorLayout,
  Effort,
  GitSnapshot,
  Message,
  ModelOption,
  PendingApproval,
  PendingQuestion,
  PermissionMode,
  ProviderCatalog,
  ProviderId,
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
  providerId: ProviderId;
  branch: string | null;
  createBranch: boolean;
  // set only by the worktree panel, meaning "run in this one"; a branch pick clears it
  worktreePath: string | null;
  worktree: boolean;
  // the worktree panel already decided branch + worktree for this draft — the composer shows
  // them read-only instead of a picker; only the sidebar's plain "New" leaves this unset
  locked: boolean;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  fast: boolean;
}

// What the draft's branch + worktree pair will actually do on send. `folder` with no checkout runs
// in the project folder as it stands; a ticked worktree always branches, so it can never conflict.
export type DraftPlan =
  | { kind: "folder"; checkout: { branch: string; createBranch: boolean } | null }
  | { kind: "worktree"; branch: string; base: string | null }
  | { kind: "here"; path: string }
  | { kind: "blocked"; reason: string };

// ai/<hex> mirrors the shape Claude Code itself uses for its own worktree branches. resolvePlan
// runs on every render for display, so the name is cached per base branch rather than rerolled
// each time — otherwise the plan chip's proposed name would change on every keystroke.
const generatedBranchNames = new Map<string, string>();

function unusedBranch(base: string, branches: Branch[]): string {
  const cached = generatedBranchNames.get(base);
  if (cached && !branches.some((branch) => branch.name === cached)) return cached;

  const taken = new Set(branches.map((branch) => branch.name));
  let name = `ai/worktree-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  while (taken.has(name)) name = `ai/worktree-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  generatedBranchNames.set(base, name);
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
  streamByTask: Record<string, Record<string, string>>;
  approvalsByThread: Record<string, PendingApproval[]>;
  questionsByThread: Record<string, PendingQuestion[]>;
  tasksByThread: Record<string, ThreadTask[]>;
  // what a running turn is waiting on, for the label under the transcript
  phaseByThread: Record<string, ThreadPhase | null>;
  // bumped a moment after a turn writes to disk or ends, so the panels showing the folder
  // re-read once per burst of tool calls instead of once per call
  fsVersionByThread: Record<string, number>;
  // set once a thread's own messages have been read, so "no messages yet" and "not read yet"
  // don't render the same empty state
  loadedThreads: Record<string, true>;
  // Slash commands belong to a provider and folder; two harnesses in one cwd may expose different lists.
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
  startDraft: (input?: { projectId?: string; branch?: string; worktreePath?: string; locked?: boolean }) => void;
  patchDraft: (patch: Partial<Draft>) => void;
  startFromDraft: (text: string) => Promise<void>;
  renameThread: (id: string, title: string) => Promise<void>;
  forkThread: (id: string) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  setLayout: (id: string, layout: EditorLayout) => void;
  removeThread: (id: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  interrupt: () => Promise<void>;
  patchActive: (patch: {
    model?: string;
    permissionMode?: PermissionMode;
    effort?: Effort;
    fast?: boolean;
  }) => Promise<void>;
  setDefaultPermissionMode: (mode: PermissionMode) => Promise<void>;
  respond: (approval: PendingApproval, decision: ApprovalDecision) => Promise<void>;
  answerQuestion: (questionId: string, answers: Record<string, string[]>) => Promise<void>;
  refreshUsage: () => Promise<void>;
  resync: () => Promise<void>;
  loadCommands: (providerId: ProviderId, cwd: string) => Promise<void>;
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
  providers: [],
  defaultProviderId: "claude",
  defaults: { model: "default", permissionMode: "default", effort: "high" },
  apps: [],
};

export const EMPTY_PROVIDER: ProviderCatalog = {
  id: "claude",
  label: "Claude Code",
  models: [],
  permissionModes: [],
  effortLevels: [],
  defaults: { model: "default", permissionMode: "default", effort: "high" },
  capabilities: {
    effort: false,
    fast: false,
    slashCommands: false,
    usage: false,
    tasks: false,
    subagentTranscripts: false,
    stopSubagents: false,
    fork: false,
    questions: false,
    liveModelSwitch: false,
    livePermissionModeSwitch: false,
    liveEffortSwitch: false,
    liveFastSwitch: false,
  },
};

export function providerCatalog(
  providers: ProviderCatalog[],
  providerId: ProviderId,
): ProviderCatalog {
  return providers.find((provider) => provider.id === providerId) ?? EMPTY_PROVIDER;
}

// Cursor scopes both knobs to the model, so a model switch can strand the chosen rung — Kimi K3
// has no `medium`. Fast always returns to off: support varies and it is a billing multiplier.
function tuneForModel(
  provider: ProviderCatalog,
  model: string,
  effort: Effort,
): { effort: Effort; fast: boolean } {
  const option = findModel(provider.models, model);
  const levels = option?.effortLevels ?? provider.effortLevels;
  return {
    effort: levels.some((level) => level.value === effort)
      ? effort
      : (option?.defaultEffort ?? provider.defaults.effort),
    fast: false,
  };
}

// mirrors the server's findModel: Cursor stores parameterized ACP ids (`grok-4.6[effort=high]`),
// so a stored model only matches its catalog entry once the parameters are stripped
const baseId = (id: string): string => (id.includes("[") ? id.slice(0, id.indexOf("[")) : id);

export function findModel(models: ModelOption[], value: string): ModelOption | null {
  if (!value) return null;
  const wanted = value === "auto" ? "default" : baseId(value);
  return (
    models.find((model) => {
      if (model.slug === value || model.resolved === value) return true;
      const slug = model.slug === "auto" ? "default" : model.slug;
      return slug === wanted || baseId(model.resolved ?? model.slug) === wanted;
    }) ?? null
  );
}

export function commandKey(providerId: ProviderId, cwd: string): string {
  return `${providerId}\u0000${cwd}`;
}

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
  return (
    message.role === "tool" &&
    (message.meta?.mutatesFiles === true ||
      WRITE_TOOLS.has(String(message.meta?.toolName ?? "")))
  );
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

// A sash drag would otherwise write once per pointer move. The trailing edge is enough because the
// optimistic update has already painted; only the server needs to wait for the gesture to settle.
const LAYOUT_SETTLE_MS = 250;
const layoutWrites = new Map<string, number>();

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
  streamByTask: {},
  approvalsByThread: {},
  questionsByThread: {},
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
    const { providers, defaultProviderId, defaults } = get();
    const provider = providerCatalog(providers, defaultProviderId);
    const permissionMode = provider.permissionModes.some((mode) => mode.value === defaults.permissionMode)
      ? defaults.permissionMode
      : provider.defaults.permissionMode;
    set({
      activeThreadId: null,
      settingsOpen: false,
      draft: {
        projectId: input?.projectId ?? null,
        providerId: provider.id,
        branch: input?.branch ?? null,
        createBranch: false,
        worktreePath: input?.worktreePath ?? null,
        worktree: Boolean(input?.worktreePath),
        locked: Boolean(input?.locked),
        model: provider.defaults.model,
        permissionMode,
        ...tuneForModel(provider, provider.defaults.model, provider.defaults.effort),
      },
    });
  },

  patchDraft: (patch) =>
    set((state) => {
      if (!state.draft) return {};
      if (patch.providerId && patch.providerId !== state.draft.providerId) {
        const provider = providerCatalog(state.providers, patch.providerId);
        return {
          draft: {
            ...state.draft,
            ...patch,
            model: provider.defaults.model,
            permissionMode: provider.defaults.permissionMode,
            ...tuneForModel(provider, provider.defaults.model, provider.defaults.effort),
          },
        };
      }
      if (patch.model && patch.model !== state.draft.model) {
        const provider = providerCatalog(state.providers, state.draft.providerId);
        return {
          draft: {
            ...state.draft,
            ...patch,
            ...tuneForModel(provider, patch.model, state.draft.effort),
          },
        };
      }
      return { draft: { ...state.draft, ...patch } };
    }),

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
      providerId: draft.providerId,
      ...(cwd ? { cwd } : {}),
      model: draft.model,
      permissionMode: draft.permissionMode,
      effort: draft.effort,
      fast: draft.fast,
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

  setLayout: (id, layout) => {
    const current = get().threads.find((thread) => thread.id === id);
    if (current) set((state) => ({ threads: upsertThread(state.threads, { ...current, layout }) }));
    window.clearTimeout(layoutWrites.get(id));
    layoutWrites.set(
      id,
      window.setTimeout(() => {
        layoutWrites.delete(id);
        api.setThreadLayout(id, persistable(layout)).catch((error: Error) => set({ error: error.message }));
      }, LAYOUT_SETTLE_MS),
    );
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
    const current = get().threads.find((thread) => thread.id === id);
    const next =
      current && patch.model && patch.model !== current.model
        ? {
            ...patch,
            ...tuneForModel(
              providerCatalog(get().providers, current.providerId),
              patch.model,
              patch.effort ?? current.effort,
            ),
          }
        : patch;
    set((state) => ({
      threads: state.threads.map((thread) => (thread.id === id ? { ...thread, ...next } : thread)),
    }));
    try {
      const thread = await api.patchThread(id, next);
      set((state) => ({ threads: upsertThread(state.threads, thread) }));
    } catch (error) {
      set({ error: (error as Error).message });
      await get().refreshState();
    }
  },

  // machine-wide, not thread-scoped — patchActive above only ever touches the open thread
  setDefaultPermissionMode: async (mode) => {
    const previous = get().defaults;
    set({ defaults: { ...previous, permissionMode: mode } });
    try {
      const { defaults } = await api.saveDefaults({ permissionMode: mode });
      set({ defaults });
    } catch (error) {
      set({ error: (error as Error).message });
      await get().refreshState();
    }
  },

  // the approval carries its own thread, so answering after switching sessions still lands right
  respond: async (approval, decision) => {
    const { id, threadId } = approval;
    set((state) => ({
      approvalsByThread: {
        ...state.approvalsByThread,
        [threadId]: (state.approvalsByThread[threadId] ?? []).filter((entry) => entry.id !== id),
      },
    }));
    await api.respondToApproval(threadId, id, decision).catch((error: Error) => {
      set((state) => ({
        error: error.message,
        approvalsByThread: {
          ...state.approvalsByThread,
          [threadId]: (state.approvalsByThread[threadId] ?? []).some((entry) => entry.id === id)
            ? state.approvalsByThread[threadId]!
            : [...(state.approvalsByThread[threadId] ?? []), approval],
        },
      }));
    });
  },

  answerQuestion: async (questionId, answers) => {
    const id = get().activeThreadId;
    if (!id) return;
    const question = get().questionsByThread[id]?.find((entry) => entry.id === questionId);
    set((state) => ({
      questionsByThread: {
        ...state.questionsByThread,
        [id]: (state.questionsByThread[id] ?? []).filter(
          (question) => question.id !== questionId,
        ),
      },
    }));
    await api.respondToQuestion(id, questionId, answers).catch((error: Error) => {
      set((state) => ({
        error: error.message,
        ...(question
          ? {
              questionsByThread: {
                ...state.questionsByThread,
                [id]: (state.questionsByThread[id] ?? []).some(
                  (entry) => entry.id === question.id,
                )
                  ? state.questionsByThread[id]!
                  : [...(state.questionsByThread[id] ?? []), question],
              },
            }
          : {}),
      }));
    });
  },

  // A cold read may spawn a CLI, so each provider-folder pair is only asked once.
  loadCommands: async (providerId, cwd) => {
    const key = commandKey(providerId, cwd);
    if (get().commandsByCwd[key]) return;
    const commands = await api.commands(providerId, cwd).then(
      (body) => body.commands,
      () => null,
    );
    if (commands) {
      set((state) => ({ commandsByCwd: { ...state.commandsByCwd, [key]: commands } }));
    }
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
          streamByTask: { ...state.streamByTask, [event.threadId]: {} },
          tasksByThread: { ...state.tasksByThread, [event.threadId]: [] },
          approvalsByThread: { ...state.approvalsByThread, [event.threadId]: [] },
          questionsByThread: { ...state.questionsByThread, [event.threadId]: [] },
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
      case "thread.task.delta": {
        set((state) => {
          const byThread = state.streamByTask[event.threadId] ?? {};
          return {
            streamByTask: {
              ...state.streamByTask,
              [event.threadId]: {
                ...byThread,
                [event.taskId]: (byThread[event.taskId] ?? "") + event.text,
              },
            },
          };
        });
        return;
      }
      case "thread.task.delta.end": {
        set((state) => {
          const byThread = { ...(state.streamByTask[event.threadId] ?? {}) };
          delete byThread[event.taskId];
          return { streamByTask: { ...state.streamByTask, [event.threadId]: byThread } };
        });
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
                  sessionId:
                    event.sessionId !== undefined ? event.sessionId : thread.sessionId,
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
      case "provider.changed": {
        set((state) => ({
          providers: state.providers.some((provider) => provider.id === event.provider.id)
            ? state.providers.map((provider) =>
                provider.id === event.provider.id ? event.provider : provider,
              )
            : [...state.providers, event.provider],
        }));
        return;
      }
      case "defaults.changed": {
        set({ defaults: event.defaults });
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
      case "thread.question": {
        set((state) => ({
          questionsByThread: {
            ...state.questionsByThread,
            [event.question.threadId]: [
              ...(state.questionsByThread[event.question.threadId] ?? []),
              event.question,
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
        const thread = get().threads.find((entry) => entry.id === event.threadId);
        if (!thread) return;
        const key = commandKey(thread.providerId, thread.cwd);
        set((state) => ({
          commandsByCwd: { ...state.commandsByCwd, [key]: event.commands },
        }));
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
      case "thread.questions": {
        const byThread: Record<string, PendingQuestion[]> = {};
        for (const question of event.questions) {
          (byThread[question.threadId] ??= []).push(question);
        }
        set({ questionsByThread: byThread });
        return;
      }
      case "thread.question.resolved": {
        set((state) => ({
          questionsByThread: {
            ...state.questionsByThread,
            [event.threadId]: (state.questionsByThread[event.threadId] ?? []).filter(
              (question) => question.id !== event.questionId,
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

// System mode has to react to the OS flipping underneath it with no user action of its own —
// this is the one path that changes what's rendered without a setAppearance call. Re-running
// applyAppearance recomputes the .dark class; re-setting `appearance` to a fresh reference is
// what makes every component reading it (Mermaid, Excalidraw, the terminal) re-render, since
// the persisted `mode` string itself never changes
watchSystemMode(() => {
  const { appearance } = useStore.getState();
  if (appearance.mode !== "system") return;
  applyAppearance(appearance);
  useStore.setState({ appearance: { ...appearance } });
});

export function useActiveThread(): Thread | null {
  return useStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId) ?? null);
}
