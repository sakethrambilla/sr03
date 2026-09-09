// Provider-scoped model and mode catalogs. Discovered models are cached in sqlite and pushed to
// clients; the UI always has a small fallback catalog for a new draft.
import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

import { publish } from "./bus.ts";
import { settings } from "./db.ts";
import type {
  Effort,
  EffortOption,
  ModelOption,
  PermissionMode,
  PermissionModeOption,
  ProviderCatalog,
  ProviderId,
} from "./types.ts";

export const DEFAULT_PROVIDER_ID: ProviderId = "claude";
export const DEFAULT_MODEL = "default";
export const DEFAULT_EFFORT: Effort = "high";

// faint-to-deep; the display order for whichever subset a model exposes
export const EFFORT_ORDER: Effort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const EFFORT_LEVELS: EffortOption[] = [
  { value: "low", label: "Low", hint: "Minimal thinking, fastest" },
  { value: "medium", label: "Medium", hint: "Moderate thinking" },
  { value: "high", label: "High", hint: "Deep reasoning" },
  { value: "xhigh", label: "Extra", hint: "Deeper than high" },
  { value: "max", label: "Max", hint: "Maximum effort" },
];

const CLAUDE_MODES: PermissionModeOption[] = [
  { value: "default", label: "Ask", hint: "Prompt before tool use" },
  { value: "acceptEdits", label: "Accept edits", hint: "Auto-approve file edits" },
  { value: "plan", label: "Plan", hint: "Read-only, plan first" },
  { value: "bypassPermissions", label: "Bypass", hint: "Run everything, no prompts" },
];

const CURSOR_MODES: PermissionModeOption[] = [
  { value: "default", label: "Agent", hint: "Prompt before risky tool use" },
  { value: "autoReview", label: "Auto-review", hint: "Automatically review safe tool calls" },
  { value: "plan", label: "Plan", hint: "Read-only planning mode" },
  { value: "ask", label: "Ask", hint: "Read-only questions and explanations" },
  { value: "bypassPermissions", label: "Force", hint: "Allow tools unless explicitly denied" },
];

const MODES: Record<ProviderId, PermissionModeOption[]> = { claude: CLAUDE_MODES, cursor: CURSOR_MODES };
const BUILTIN_PERMISSION_MODE: Record<ProviderId, PermissionMode> = { claude: "default", cursor: "default" };

const PERMISSION_MODE_KEY: Record<ProviderId, string> = {
  claude: "defaultPermissionMode:claude",
  cursor: "defaultPermissionMode:cursor",
};
// the single machine-wide default this replaced; carried onto the default provider once
const LEGACY_PERMISSION_MODE_KEY = "defaultPermissionMode";

const FALLBACKS: Record<ProviderId, ModelOption[]> = {
  claude: [{ slug: DEFAULT_MODEL, label: "Default", hint: "Whichever model Claude Code picks" }],
  cursor: [{ slug: "auto", label: "Auto", hint: "Whichever model Cursor picks" }],
};

const MODELS_KEY: Record<ProviderId, string> = {
  claude: "models:claude",
  cursor: "models:cursor:acp",
};

function loadStored(providerId: ProviderId): ModelOption[] | null {
  const stored = settings.all();
  const raw = stored[MODELS_KEY[providerId]] ?? (providerId === "claude" ? stored.models : undefined);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ModelOption[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

const known: Record<ProviderId, ModelOption[]> = {
  claude: loadStored("claude") ?? FALLBACKS.claude,
  cursor: loadStored("cursor") ?? FALLBACKS.cursor,
};

function makeCatalog(providerId: ProviderId): ProviderCatalog {
  if (providerId === "claude") {
    return {
      id: "claude",
      label: "Claude Code",
      models: known.claude,
      permissionModes: CLAUDE_MODES,
      effortLevels: EFFORT_LEVELS,
      defaults: {
        model: DEFAULT_MODEL,
        permissionMode: permissionModeDefaults.claude,
        effort: DEFAULT_EFFORT,
      },
      capabilities: {
        effort: true,
        fast: false,
        slashCommands: true,
        usage: true,
        tasks: true,
        subagentTranscripts: true,
        stopSubagents: true,
        fork: true,
        questions: false,
        liveModelSwitch: true,
        livePermissionModeSwitch: true,
        liveEffortSwitch: true,
        liveFastSwitch: false,
      },
    };
  }
  return {
    id: "cursor",
    label: "Cursor CLI",
    models: known.cursor,
    permissionModes: CURSOR_MODES,
    effortLevels: [],
    defaults: { model: "auto", permissionMode: permissionModeDefaults.cursor, effort: DEFAULT_EFFORT },
    capabilities: {
      effort: true,
      fast: true,
      slashCommands: true,
      usage: false,
      tasks: true,
      subagentTranscripts: false,
      stopSubagents: false,
      fork: false,
      questions: true,
      liveModelSwitch: false,
      livePermissionModeSwitch: false,
      liveEffortSwitch: false,
      liveFastSwitch: false,
    },
  };
}

export function currentProvider(providerId: ProviderId): ProviderCatalog {
  return makeCatalog(providerId);
}

export function currentProviders(): ProviderCatalog[] {
  return [makeCatalog("claude"), makeCatalog("cursor")];
}

export function defaultProviderId(): ProviderId {
  const value = settings.all().defaultProviderId;
  return isProviderId(value) ? value : DEFAULT_PROVIDER_ID;
}

async function readClaudeCatalog(): Promise<ModelOption[]> {
  const session = query({
    prompt: (async function* () {})(),
    options: { systemPrompt: { type: "preset", preset: "claude_code" }, cwd: os.homedir() },
  });
  try {
    const models = await session.supportedModels();
    return models.length === 0
      ? FALLBACKS.claude
      : models.map((model) => ({
          slug: model.value,
          label: model.displayName,
          hint: model.description,
          resolved: model.resolvedModel,
        }));
  } finally {
    session.close();
  }
}

const inFlight: Partial<Record<ProviderId, Promise<ModelOption[]>>> = {};

async function readCursorCatalog(): Promise<ModelOption[]> {
  const { discoverCursorModels } = await import("./agents/cursor.ts");
  const models = await discoverCursorModels();
  return models.length === 0 ? known.cursor : models;
}

// Every provider shares one warm lookup. Changed answers are persisted and pushed to every client.
export function listModels(providerId: ProviderId): Promise<ModelOption[]> {
  const existing = inFlight[providerId];
  if (existing) return existing;
  const reading = (providerId === "cursor" ? readCursorCatalog() : readClaudeCatalog())
    .then((models) => {
      updateProviderModels(providerId, models);
      return known[providerId];
    })
    .catch((error: Error) => {
      console.error(`[models:${providerId}] ${error.message}`);
      delete inFlight[providerId];
      return known[providerId];
    });
  inFlight[providerId] = reading;
  return reading;
}

// Cursor advertises picker slugs through `cursor/list_available_models`. Session setup still
// maps those slugs onto ACP `session/set_model` after every new or loaded session.
export function updateProviderModels(providerId: ProviderId, models: ModelOption[]): ProviderCatalog {
  if (models.length === 0 || JSON.stringify(models) === JSON.stringify(known[providerId])) {
    return makeCatalog(providerId);
  }
  known[providerId] = models;
  settings.set(MODELS_KEY[providerId], JSON.stringify(models));
  const provider = makeCatalog(providerId);
  publish({ type: "provider.changed", provider });
  return provider;
}

// one-shot at import: the legacy value lands on the default provider and is then retired, so a
// later change of default provider can never migrate it a second time
function migrateLegacyPermissionMode(): void {
  const stored = settings.all();
  const legacy = stored[LEGACY_PERMISSION_MODE_KEY];
  if (legacy === undefined) return;
  const providerId = defaultProviderId();
  if (isPermissionMode(providerId, legacy) && stored[PERMISSION_MODE_KEY[providerId]] === undefined) {
    settings.set(PERMISSION_MODE_KEY[providerId], legacy);
  }
  settings.delete(LEGACY_PERMISSION_MODE_KEY);
}

function loadPermissionMode(providerId: ProviderId): PermissionMode {
  const stored = settings.all()[PERMISSION_MODE_KEY[providerId]];
  return isPermissionMode(providerId, stored) ? stored : BUILTIN_PERMISSION_MODE[providerId];
}

migrateLegacyPermissionMode();

const permissionModeDefaults: Record<ProviderId, PermissionMode> = {
  claude: loadPermissionMode("claude"),
  cursor: loadPermissionMode("cursor"),
};

export function setDefaultPermissionMode(providerId: ProviderId, mode: PermissionMode): ProviderCatalog {
  permissionModeDefaults[providerId] = mode;
  settings.set(PERMISSION_MODE_KEY[providerId], mode);
  const provider = makeCatalog(providerId);
  publish({ type: "provider.changed", provider });
  return provider;
}

export function isProviderId(value: unknown): value is ProviderId {
  return value === "claude" || value === "cursor";
}

export function isPermissionMode(
  providerId: ProviderId,
  value: unknown,
): value is PermissionMode {
  return MODES[providerId].some((mode) => mode.value === value);
}

export function findModel(providerId: ProviderId, value: unknown): ModelOption | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const wanted = value === "auto" ? "default" : value.includes("[") ? value.slice(0, value.indexOf("[")) : value;
  return (
    makeCatalog(providerId).models.find((model) => {
      if (model.slug === value || model.resolved === value) return true;
      const slug = model.slug === "auto" ? "default" : model.slug;
      const resolved = model.resolved ?? model.slug;
      const resolvedBase = resolved.includes("[") ? resolved.slice(0, resolved.indexOf("[")) : resolved;
      return slug === wanted || resolvedBase === wanted;
    }) ?? null
  );
}

export function isModel(providerId: ProviderId, value: unknown): value is string {
  return findModel(providerId, value) !== null;
}

// Cursor scopes effort to the selected model — Kimi K3 offers low/high/max and nothing between —
// so the model's own ladder wins, and the provider's flat list is the fallback Claude Code uses.
export function effortLevelsFor(providerId: ProviderId, model: string): EffortOption[] {
  const provider = makeCatalog(providerId);
  return findModel(providerId, model)?.effortLevels ?? provider.effortLevels;
}

export function defaultEffortFor(providerId: ProviderId, model: string): Effort {
  const provider = makeCatalog(providerId);
  const option = findModel(providerId, model);
  if (option?.defaultEffort) return option.defaultEffort;
  const levels = effortLevelsFor(providerId, model);
  return levels.some((level) => level.value === provider.defaults.effort)
    ? provider.defaults.effort
    : (levels[levels.length - 1]?.value ?? provider.defaults.effort);
}

export function supportsFast(providerId: ProviderId, model: string): boolean {
  return (
    makeCatalog(providerId).capabilities.fast && findModel(providerId, model)?.fast !== undefined
  );
}

export function isEffort(providerId: ProviderId, model: string, value: unknown): value is Effort {
  const provider = makeCatalog(providerId);
  if (!provider.capabilities.effort) return value === provider.defaults.effort;
  const levels = effortLevelsFor(providerId, model);
  // a model with no ladder of its own — Cursor's Auto — keeps the stored value inert but valid
  return levels.length === 0
    ? value === provider.defaults.effort
    : levels.some((level) => level.value === value);
}
