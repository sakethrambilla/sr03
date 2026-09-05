// The terminal panel: xterm tabs, each bound to one of the server's PTYs over the socket rather
// than through the store, since a keystroke must not re-render the app. Lazily imported by
// ChatView — xterm is ~490 KB, for a panel most sessions never open.
import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { Thread } from "../lib/types.ts";
import { onPtyEvent, sendClientMessage } from "../lib/ws.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CloseIcon, MaximizeIcon, PlusIcon, RestoreIcon, TerminalIcon, cn } from "./ui.tsx";

// the panel keeps a few rows visible however hard you drag. VS Code's equivalent floor is 77px
// for a panel with no tab strip of its own
const MIN_HEIGHT = 120;
// and it always leaves this much of the session above it, measured from <main>: the 60px header
// plus the composer's 107px resting height plus a sliver of transcript
const MIN_CONTENT = 240;

// xterm needs a literal color, and canvas normalises any CSS color the browser understands —
// so the oklch theme tokens can drive the terminal without being duplicated as hex
function monoFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim();
}

function terminalTheme() {
  return {
    background: themeColor("--color-card", "#1a1a19"),
    foreground: themeColor("--color-foreground", "#f0efed"),
    cursor: themeColor("--color-primary", "#d9743f"),
    selectionBackground: themeColor("--color-accent", "#3a3937"),
  };
}

function themeColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const probe = document.createElement("canvas").getContext("2d");
  if (!raw || !probe) return fallback;
  probe.fillStyle = fallback;
  probe.fillStyle = raw;
  return String(probe.fillStyle);
}

function TerminalView({
  threadId,
  terminalId,
  visible,
  connected,
}: {
  threadId: string;
  terminalId: string;
  visible: boolean;
  connected: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const fitted = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const appearance = useStore((state) => state.appearance);

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: monoFamily(),
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fitted.current = { term, fit };
    if (visible) fit.fit();

    const unsubscribe = onPtyEvent((event) => {
      if (event.type === "pty.terminals" || event.type === "pty.created") return;
      if (event.terminalId !== terminalId) return;
      if (event.type === "pty.snapshot") {
        term.reset();
        if (event.data) term.write(event.data);
      } else if (event.type === "pty.data") {
        term.write(event.data);
      }
    });

    sendClientMessage({ type: "pty.open", threadId, terminalId, cols: term.cols, rows: term.rows });
    const input = term.onData((data) =>
      sendClientMessage({ type: "pty.input", threadId, terminalId, data }),
    );

    // a hidden terminal measures as zero, so only the visible one may refit. dragging the
    // panel fires this per pixel, where only every fifteenth or so changes the row count
    const sent = { cols: 0, rows: 0 };
    const observer = new ResizeObserver(() => {
      if (container.offsetParent === null) return;
      fit.fit();
      if (term.cols === sent.cols && term.rows === sent.rows) return;
      sent.cols = term.cols;
      sent.rows = term.rows;
      sendClientMessage({ type: "pty.resize", threadId, terminalId, cols: term.cols, rows: term.rows });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      term.dispose();
      fitted.current = null;
    };
  }, [threadId, terminalId]);

  useEffect(() => {
    if (!connected || !fitted.current) return;
    const { term } = fitted.current;
    sendClientMessage({ type: "pty.open", threadId, terminalId, cols: term.cols, rows: term.rows });
  }, [connected, threadId, terminalId]);

  // xterm reads the palette once at construction, so a theme or font change has to be handed
  // over — and a new family changes the cell size, which the shell has to be told about
  useEffect(() => {
    const entry = fitted.current;
    if (!entry) return;
    entry.term.options.theme = terminalTheme();
    entry.term.options.fontFamily = monoFamily();
    if (host.current?.offsetParent === null) return;
    entry.fit.fit();
    sendClientMessage({ type: "pty.resize", threadId, terminalId, cols: entry.term.cols, rows: entry.term.rows });
  }, [appearance, threadId, terminalId]);

  // coming back to a tab that was hidden needs a fresh measurement
  useEffect(() => {
    if (!visible || !fitted.current) return;
    const { term, fit } = fitted.current;
    fit.fit();
    sendClientMessage({ type: "pty.resize", threadId, terminalId, cols: term.cols, rows: term.rows });
    term.focus();
  }, [visible, threadId, terminalId]);

  return <div ref={host} className={cn("min-h-0 flex-1 px-2 py-1", visible ? "" : "hidden")} />;
}

export function TerminalPanel({
  thread,
  command,
  height,
  defaultHeight,
  maximized,
  onHeightChange,
  onToggleMaximize,
  onClose,
}: {
  thread: Thread;
  command: { text: string; key: number } | null;
  height: number;
  defaultHeight: number;
  maximized: boolean;
  onHeightChange: (height: number) => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  const connected = useStore((state) => state.connected);
  const section = useRef<HTMLElement>(null);
  // ids and the active one move together, so they share a single updater
  const [tabs, setTabs] = useState<{ ids: string[]; active: string | null }>({ ids: [], active: null });
  const [ready, setReady] = useState(false);
  const { ids, active } = tabs;

  const drop = (terminalId: string) =>
    setTabs((prev) => {
      const index = prev.ids.indexOf(terminalId);
      if (index === -1) return prev;
      const next = prev.ids.filter((id) => id !== terminalId);
      return {
        ids: next,
        active: prev.active === terminalId ? (next[index] ?? next[index - 1] ?? null) : prev.active,
      };
    });

  useEffect(() => {
    const unsubscribe = onPtyEvent((event) => {
      if (event.threadId !== thread.id) return;

      if (event.type === "pty.terminals") {
        setReady(true);
        if (event.ids.length === 0) {
          sendClientMessage({ type: "pty.create", threadId: thread.id, cols: 80, rows: 24 });
          return;
        }
        setTabs((prev) => ({
          ids: event.ids,
          active: prev.active && event.ids.includes(prev.active) ? prev.active : event.ids[0]!,
        }));
        return;
      }

      if (event.type === "pty.created") {
        setTabs((prev) => ({
          ids: prev.ids.includes(event.terminalId) ? prev.ids : [...prev.ids, event.terminalId],
          active: event.terminalId,
        }));
        return;
      }

      // the shell exited on its own, so the tab goes with it
      if (event.type === "pty.exit") drop(event.terminalId);
    });

    // the server owns the terminals, so a remount reattaches instead of spawning more.
    // asking again on every (re)connect matters: a socket that is still opening drops the send
    if (connected) sendClientMessage({ type: "pty.list", threadId: thread.id });
    return unsubscribe;
  }, [thread.id, connected]);

  const close = (terminalId: string) => {
    sendClientMessage({ type: "pty.close", threadId: thread.id, terminalId });
    drop(terminalId);
  };

  // a command run from the chat waits for the shell it landed on to exist, which it does not
  // yet when the click is what opened this panel
  const ran = useRef<number | null>(null);
  useEffect(() => {
    if (!command || !active || ran.current === command.key) return;
    ran.current = command.key;
    const data = `${command.text.replace(/\r?\n/g, "\r").replace(/\r+$/, "")}\r`;
    sendClientMessage({ type: "pty.input", threadId: thread.id, terminalId: active, data });
  }, [command, active, thread.id]);

  // the panel exists to hold terminals; the last one closing takes it with them. opening it
  // on a thread that has none is not that — the first shell is still being spawned
  const spawned = useRef(false);
  if (ids.length > 0) spawned.current = true;

  useEffect(() => {
    if (ready && spawned.current && ids.length === 0) onClose();
  }, [ready, ids.length]);

  // the drag writes the height straight to the element and only commits on release: routing
  // every pointer move through React would re-render the transcript, the composer and every
  // open file at pointer rate. xterm still refits live, off its own ResizeObserver
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = section.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const startY = event.clientY;
    const startHeight = el.getBoundingClientRect().height;
    const ceiling = Math.max(parent.getBoundingClientRect().height - MIN_CONTENT, MIN_HEIGHT);
    let settled = startHeight;

    const move = (moved: PointerEvent) => {
      settled = Math.min(Math.max(startHeight - (moved.clientY - startY), MIN_HEIGHT), ceiling);
      el.style.height = `${settled}px`;
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      window.removeEventListener("pointercancel", done);
      onHeightChange(settled);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    // a cancelled pointer would otherwise leave the move listener resizing forever
    window.addEventListener("pointercancel", done);
  };

  return (
    <section
      ref={section}
      // the stored height came from whatever window it was dragged in, so a smaller one now
      // must still leave the transcript something
      style={maximized ? undefined : { height: `min(${height}px, calc(100% - ${MIN_CONTENT}px))` }}
      className={cn(
        "relative flex flex-col border-t border-border/60 bg-card",
        maximized ? "min-h-0 flex-1" : "shrink-0",
      )}
    >
      {maximized ? null : (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal panel"
          onPointerDown={startResize}
          onDoubleClick={() => onHeightChange(defaultHeight)}
          className="absolute inset-x-0 -top-px z-20 h-1 cursor-ns-resize transition-colors delay-150 hover:bg-primary/70"
        />
      )}
      <header className="flex items-center gap-1 border-b border-border/60 px-3 py-1.5">
        <TerminalIcon className="size-3.5 shrink-0 text-faint" />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {ids.map((id, index) => (
            <div
              key={id}
              className={cn(
                "group/term flex h-6 shrink-0 items-center gap-1 rounded-md pr-1 pl-2 text-[11.5px] transition",
                id === active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <button onClick={() => setTabs((prev) => ({ ...prev, active: id }))}>
                Terminal {index + 1}
              </button>
              <button
                onClick={() => close(id)}
                aria-label={`Close terminal ${index + 1}`}
                className={cn(
                  "grid size-3.5 place-items-center rounded text-faint transition hover:text-foreground",
                  id === active ? "" : "opacity-0 group-hover/term:opacity-100",
                )}
              >
                <CloseIcon className="size-2.5" />
              </button>
            </div>
          ))}
          <Button
            variant="ghost"
            size="icon"
            aria-label="New terminal"
            title="New terminal"
            onClick={() =>
              sendClientMessage({ type: "pty.create", threadId: thread.id, cols: 80, rows: 24 })
            }
            className="size-6 shrink-0 text-faint"
          >
            <PlusIcon className="size-3" />
          </Button>
        </div>
        <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-faint">
          {thread.cwd.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              onClick={onToggleMaximize}
              aria-label={maximized ? "Restore terminal panel" : "Maximize terminal panel"}
            >
              {maximized ? <RestoreIcon /> : <MaximizeIcon />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{maximized ? "Restore" : "Maximize"}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" onClick={onClose} aria-label="Hide terminal panel">
          <CloseIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {ids.map((id) => (
          <TerminalView
            key={id}
            threadId={thread.id}
            terminalId={id}
            visible={id === active}
            connected={connected}
          />
        ))}
      </div>
    </section>
  );
}
