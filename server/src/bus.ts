// In-process pub/sub, and the whole of sr03's push side: anything that changes publishes one
// ServerEvent here, and index.ts is the listener that writes it to every open socket.
import type { ServerEvent } from "./types.ts";

// the wire form travels with the event, so one serialisation feeds every socket
type Listener = (event: ServerEvent, json: string) => void;

const listeners = new Set<Listener>();

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publish(event: ServerEvent): void {
  const json = JSON.stringify(event);
  for (const listener of listeners) {
    try {
      listener(event, json);
    } catch (error) {
      console.error("[bus] listener failed", error);
    }
  }
}
