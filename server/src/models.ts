import type { PermissionMode } from "./types.ts";

export interface ModelOption {
  slug: string;
  label: string;
  hint: string;
}

export const MODELS: ModelOption[] = [
  { slug: "claude-opus-4-6", label: "Opus 4.6", hint: "Most capable" },
  { slug: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "Balanced" },
  { slug: "claude-haiku-4-5", label: "Haiku 4.5", hint: "Fastest" },
];

export const DEFAULT_MODEL = MODELS[1]!.slug;

export const PERMISSION_MODES: Array<{ value: PermissionMode; label: string; hint: string }> = [
  { value: "default", label: "Ask", hint: "Prompt before tool use" },
  { value: "acceptEdits", label: "Accept edits", hint: "Auto-approve file edits" },
  { value: "plan", label: "Plan", hint: "Read-only, plan first" },
  { value: "bypassPermissions", label: "Bypass", hint: "Run everything, no prompts" },
];

export const DEFAULT_PERMISSION_MODE: PermissionMode = "default";

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode.value === value);
}
