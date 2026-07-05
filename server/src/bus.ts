import type { ServerEvent } from "./types.ts";

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: ServerEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("[bus] listener failed", error);
    }
  }
}
