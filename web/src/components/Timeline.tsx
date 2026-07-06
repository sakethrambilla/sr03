import { useEffect, useRef } from "react";

import type { Message } from "../lib/types.ts";
import { Markdown } from "./Markdown.tsx";
import { cn } from "./ui.tsx";

function ToolCard({ message }: { message: Message }) {
  const meta = message.meta ?? {};
  const name = String(meta.toolName ?? "tool");
  const input = meta.input as Record<string, unknown> | undefined;
  const summary =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.file_path === "string"
        ? input.file_path
        : typeof input?.pattern === "string"
          ? input.pattern
          : typeof input?.description === "string"
            ? input.description
            : "";

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/70 bg-card/50 px-3 py-2">
      <span className="shrink-0 font-mono text-[11px] font-semibold text-primary">{name}</span>
      {summary ? <span className="truncate font-mono text-[11px] text-muted-foreground">{summary}</span> : null}
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  if (message.role === "tool") return <ToolCard message={message} />;
  if (message.role === "system") {
    return <p className="text-center text-[11px] text-faint">{message.text}</p>;
  }

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-accent px-3.5 py-2 text-[14px] leading-relaxed whitespace-pre-wrap text-foreground">
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <Markdown
      text={message.text}
      className={cn(
        "text-[14px] leading-[1.65]",
        message.role === "error"
          ? "rounded-lg border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-destructive"
          : "text-foreground",
      )}
    />
  );
}

export function Timeline({
  messages,
  streaming,
  running,
}: {
  messages: Message[];
  streaming: string;
  running: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, streaming]);

  if (messages.length === 0 && !streaming) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-[13px] text-faint">Send a message to start this thread.</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-5 py-6">
        {messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {streaming ? (
          <Markdown text={`${streaming}\u258f`} className="text-[14px] leading-[1.65] text-foreground" />
        ) : running ? (
          <p className="text-[12px] text-faint">Working…</p>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
