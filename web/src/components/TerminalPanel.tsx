import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import type { Thread } from "../lib/types.ts";
import { onPtyEvent, sendClientMessage } from "../lib/ws.ts";
import { Button } from "@/components/ui/button";
import { CloseIcon, TerminalIcon } from "./ui.tsx";

// xterm needs a literal color, and canvas normalises any CSS color the browser understands —
// so the oklch theme tokens can drive the terminal without being duplicated as hex
function themeColor(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const probe = document.createElement("canvas").getContext("2d");
  if (!raw || !probe) return fallback;
  probe.fillStyle = fallback;
  probe.fillStyle = raw;
  return String(probe.fillStyle);
}

export function TerminalPanel({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = host.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim(),
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: {
        background: themeColor("--color-card", "#1a1a19"),
        foreground: themeColor("--color-foreground", "#f0efed"),
        cursor: themeColor("--color-primary", "#d9743f"),
        selectionBackground: themeColor("--color-accent", "#3a3937"),
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const unsubscribe = onPtyEvent((event) => {
      if (event.threadId !== thread.id) return;
      if (event.type === "pty.snapshot") {
        term.reset();
        if (event.data) term.write(event.data);
      } else if (event.type === "pty.data") {
        term.write(event.data);
      } else {
        term.writeln("\r\n[2m[shell exited — reopen the panel to start a new one][0m");
      }
    });

    sendClientMessage({ type: "pty.open", threadId: thread.id, cols: term.cols, rows: term.rows });
    const input = term.onData((data) =>
      sendClientMessage({ type: "pty.input", threadId: thread.id, data }),
    );

    const observer = new ResizeObserver(() => {
      fit.fit();
      sendClientMessage({ type: "pty.resize", threadId: thread.id, cols: term.cols, rows: term.rows });
    });
    observer.observe(container);
    term.focus();

    return () => {
      observer.disconnect();
      unsubscribe();
      input.dispose();
      term.dispose();
    };
  }, [thread.id]);

  return (
    <section className="flex h-64 shrink-0 flex-col border-t border-border/60 bg-card">
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
        <TerminalIcon className="size-3.5 text-faint" />
        <h2 className="text-[12px] font-medium">Terminal</h2>
        <span className="min-w-0 truncate font-mono text-[10.5px] text-faint">
          {thread.cwd.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <div className="flex-1" />
        <Button variant="ghost" onClick={onClose} aria-label="Close terminal">
          <CloseIcon />
        </Button>
      </header>
      <div ref={host} className="min-h-0 flex-1 px-2 py-1" />
    </section>
  );
}
