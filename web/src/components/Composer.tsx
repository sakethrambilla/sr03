import { useState } from "react";

import type { PendingApproval, PermissionMode, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { Button } from "./ui.tsx";

const NO_APPROVALS: PendingApproval[] = [];

function ApprovalPanel({ approval }: { approval: PendingApproval }) {
  const respond = useStore((state) => state.respond);
  const input = approval.input as Record<string, unknown> | null;
  const detail =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.file_path === "string"
        ? input.file_path
        : JSON.stringify(input ?? {}).slice(0, 300);

  return (
    <div className="mb-2 rounded-lg border border-accent/50 bg-accent/10 px-3 py-2.5">
      <p className="text-[13px] font-medium">
        Allow <span className="font-mono text-accent">{approval.toolName}</span>?
      </p>
      <p className="mt-1 truncate font-mono text-[11px] text-muted">{detail}</p>
      <div className="mt-2 flex gap-2">
        <Button variant="primary" onClick={() => void respond(approval.id, "allow")}>
          Allow once
        </Button>
        <Button onClick={() => void respond(approval.id, "always")}>Always allow</Button>
        <Button variant="danger" onClick={() => void respond(approval.id, "deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

export function Composer({ thread }: { thread: Thread }) {
  const send = useStore((state) => state.send);
  const interrupt = useStore((state) => state.interrupt);
  const patchActive = useStore((state) => state.patchActive);
  const models = useStore((state) => state.models);
  const permissionModes = useStore((state) => state.permissionModes);
  const approvals = useStore((state) => state.approvalsByThread[thread.id] ?? NO_APPROVALS);
  const [text, setText] = useState("");

  const running = thread.status === "running";

  const submit = () => {
    const value = text.trim();
    if (!value || running) return;
    setText("");
    void send(value);
  };

  return (
    <div className="border-t border-line bg-panel/60 px-5 py-3">
      <div className="mx-auto max-w-3xl">
        {approvals.map((approval) => (
          <ApprovalPanel key={approval.id} approval={approval} />
        ))}

        <div className="rounded-xl border border-line bg-canvas focus-within:border-accent">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
            rows={3}
            placeholder={running ? "Claude is working…" : "Ask Claude to change something…"}
            className="w-full resize-none bg-transparent px-3.5 py-3 text-[13.5px] text-ink outline-none placeholder:text-faint"
          />
          <div className="flex flex-wrap items-center gap-2 border-t border-line/60 px-2.5 py-2">
            <select
              value={thread.model}
              onChange={(event) => void patchActive({ model: event.target.value })}
              className="h-7 cursor-pointer rounded-md border border-line bg-panel px-1.5 text-[12px] outline-none hover:bg-raised"
            >
              {models.map((model) => (
                <option key={model.slug} value={model.slug}>
                  {model.label}
                </option>
              ))}
            </select>
            <select
              value={thread.permissionMode}
              onChange={(event) =>
                void patchActive({ permissionMode: event.target.value as PermissionMode })
              }
              className="h-7 cursor-pointer rounded-md border border-line bg-panel px-1.5 text-[12px] outline-none hover:bg-raised"
            >
              {permissionModes.map((mode) => (
                <option key={mode.value} value={mode.value}>
                  {mode.label}
                </option>
              ))}
            </select>
            <div className="flex-1" />
            {running ? (
              <Button variant="danger" onClick={() => void interrupt()}>
                Stop
              </Button>
            ) : (
              <Button variant="primary" disabled={!text.trim()} onClick={submit}>
                Send ⏎
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
