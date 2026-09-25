import { useEffect, useRef } from "react";

import { useStore } from "../store.ts";
import { resolveBindings, step, strokeFromEvent } from "./shortcuts.ts";
import type { CommandId, Stroke } from "./shortcuts.ts";

const CHORD_MS = 1000;

const registry = new Map<CommandId, Array<{ current: () => void }>>();
let pending: Stroke | null = null;
let timer: number | undefined;
let suspended = false;
let installed = false;

export function suspendShortcuts(on: boolean): void {
  suspended = on;
}

function onKeyDown(e: KeyboardEvent): void {
  if (suspended) return;
  const stroke = strokeFromEvent(e);
  if (stroke === null) return;
  const bindings = resolveBindings(useStore.getState().shortcuts);
  const next = step(pending, stroke, bindings, (id) => (registry.get(id)?.length ?? 0) > 0);
  if (next.run || next.pending) e.preventDefault();
  window.clearTimeout(timer);
  pending = next.pending;
  if (pending) timer = window.setTimeout(() => (pending = null), CHORD_MS);
  if (next.run) registry.get(next.run)?.at(-1)?.current();
}

export function useShortcut(id: CommandId, handler: () => void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => {
    if (!enabled) return;
    if (!installed) {
      window.addEventListener("keydown", onKeyDown);
      installed = true;
    }
    const list = registry.get(id) ?? [];
    list.push(ref);
    registry.set(id, list);
    return () => {
      const at = list.lastIndexOf(ref);
      if (at >= 0) list.splice(at, 1);
    };
  }, [id, enabled]);
}
