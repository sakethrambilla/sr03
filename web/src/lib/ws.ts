import type { ClientMessage, ServerEvent } from "./types.ts";

type PtyEvent = Extract<ServerEvent, { type: `pty.${string}` }>;

const ptyListeners = new Set<(event: PtyEvent) => void>();
let active: WebSocket | null = null;

// terminal traffic bypasses the store entirely — it would rerender the app on every keystroke
export function onPtyEvent(listener: (event: PtyEvent) => void): () => void {
  ptyListeners.add(listener);
  return () => ptyListeners.delete(listener);
}

export function sendClientMessage(message: ClientMessage): void {
  if (active?.readyState === WebSocket.OPEN) active.send(JSON.stringify(message));
}

export function connectEvents(handlers: {
  onEvent: (event: ServerEvent) => void;
  onConnected: (connected: boolean) => void;
}): () => void {
  let socket: WebSocket | null = null;
  let retry: number | null = null;
  let closed = false;
  // a server that is down for a while is retried less and less often, up to every five seconds
  let backoff = 1000;

  const open = () => {
    if (closed) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    socket = new WebSocket(url);
    active = socket;
    socket.onopen = () => {
      backoff = 1000;
      handlers.onConnected(true);
    };
    socket.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as ServerEvent;
      if (event.type.startsWith("pty.")) {
        for (const listener of ptyListeners) listener(event as PtyEvent);
        return;
      }
      handlers.onEvent(event);
    };
    socket.onclose = () => {
      handlers.onConnected(false);
      if (!closed) retry = window.setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 5000);
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) window.clearTimeout(retry);
    socket?.close();
    active = null;
  };
}
