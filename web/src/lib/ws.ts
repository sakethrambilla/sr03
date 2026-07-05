import type { ServerEvent } from "./types.ts";

export function connectEvents(handlers: {
  onEvent: (event: ServerEvent) => void;
  onConnected: (connected: boolean) => void;
}): () => void {
  let socket: WebSocket | null = null;
  let retry: number | null = null;
  let closed = false;

  const open = () => {
    if (closed) return;
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    socket = new WebSocket(url);
    socket.onopen = () => handlers.onConnected(true);
    socket.onmessage = (message) => handlers.onEvent(JSON.parse(message.data as string) as ServerEvent);
    socket.onclose = () => {
      handlers.onConnected(false);
      if (!closed) retry = window.setTimeout(open, 1000);
    };
    socket.onerror = () => socket?.close();
  };

  open();

  return () => {
    closed = true;
    if (retry) window.clearTimeout(retry);
    socket?.close();
  };
}
