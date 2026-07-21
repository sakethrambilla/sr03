import os from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";

import type { Effort, PermissionMode } from "./types.ts";

export interface ModelOption {
  slug: string;
  label: string;
  hint: string;
  // the wire id the slug stands for, so a thread pinned to that id still matches this row
  resolved?: string;
}

// the CLI's own "default" row, so a thread started before the catalog answers still resolves
export const DEFAULT_MODEL = "default";

const FALLBACK_MODELS: ModelOption[] = [
  { slug: DEFAULT_MODEL, label: "Default", hint: "Whichever model the CLI picks" },
];

async function readCatalog(): Promise<ModelOption[]> {
  const session = query({
    prompt: (async function* () {})(),
    options: { systemPrompt: { type: "preset", preset: "claude_code" }, cwd: os.homedir() },
  });
  try {
    const models = await session.supportedModels();
    return models.length === 0
      ? FALLBACK_MODELS
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

let catalog: Promise<ModelOption[]> | null = null;

// the CLI takes seconds to answer, so every caller shares one warm lookup
export function listModels(): Promise<ModelOption[]> {
  catalog ??= readCatalog().catch((error: Error) => {
    console.error("[models] could not read the CLI catalog:", error.message);
    catalog = null;
    return FALLBACK_MODELS;
  });
  return catalog;
}

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "default", label: "Ask", hint: "Prompt before tool use" },
  { value: "acceptEdits", label: "Accept edits", hint: "Auto-approve file edits" },
  { value: "plan", label: "Plan", hint: "Read-only, plan first" },
  { value: "bypassPermissions", label: "Bypass", hint: "Run everything, no prompts" },
];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

// the SDK silently downgrades a level the chosen model can't do
export const EFFORT_LEVELS: Array<{ value: Effort; label: string; hint: string }> = [
  { value: "low", label: "Low", hint: "Minimal thinking, fastest" },
  { value: "medium", label: "Medium", hint: "Moderate thinking" },
  { value: "high", label: "High", hint: "Deep reasoning" },
  { value: "xhigh", label: "Extra", hint: "Deeper than high" },
  { value: "max", label: "Max", hint: "Maximum effort" },
];

export const DEFAULT_EFFORT: Effort = "high";

export function isEffort(value: unknown): value is Effort {
  return EFFORT_LEVELS.some((level) => level.value === value);
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode.value === value);
}
