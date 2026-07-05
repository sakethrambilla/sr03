import { useEffect, useRef } from "react";

import type { Message } from "../lib/types.ts";
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
    <div className="rounded-lg border border-line bg-panel/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-semibold text-accent">{name}</span>
        {summary ? <span className="truncate font-mono text-[11px] text-muted">{summary}</span> : null}
      </div>
    </div>
  );
}

function Bubble({ message }: { message: Message }) {
  if (message.role === "tool") return <ToolCard message={message} />;
  if (message.role === "system") {
    return <p className="text-center text-[11px] text-faint">{message.text}</p>;
  }

  const isUser = message.role === "user";
  const isError = message.role === "error";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-xl px-3.5 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap",
          isUser && "bg-raised text-ink",
          isError && "border border-danger/40 bg-danger/10 text-danger",
          !isUser && !isError && "text-ink",
        )}
      >
        {message.text}
      </div>
    </div>
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
        <p className="text-sm text-faint">Send a message to start this thread.</p>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-5 py-6">
        {messages.map((message) => (
          <Bubble key={message.id} message={message} />
        ))}
        {streaming ? (
          <div className="max-w-[85%] text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink">
            {streaming}
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />
          </div>
        ) : running ? (
          <p className="text-xs text-faint">Working…</p>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
