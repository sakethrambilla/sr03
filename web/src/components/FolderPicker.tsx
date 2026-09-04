// The add-a-folder dialog: browses the machine's directories through the server, since the
// browser can't hand over a real path, with the native macOS picker as the other way in.
import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { DirListing } from "../lib/types.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, Pill } from "./ui.tsx";

export function FolderPicker({
  onClose,
  onPick,
}: {
  onClose: () => void;
  onPick: (path: string) => Promise<void> | void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = (path?: string) => {
    api
      .browse(path)
      .then((next) => {
        setListing(next);
        setManual(next.path);
        setError(null);
      })
      .catch((cause: Error) => setError(cause.message));
  };

  useEffect(() => load(), []);

  const pick = async (path: string) => {
    setBusy(true);
    try {
      await onPick(path);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Add a project folder"
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between gap-3">
          <Input
            value={manual}
            onChange={(event) => setManual(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") load(manual);
            }}
            spellCheck={false}
            className="h-8 min-w-0 flex-1 font-mono text-xs"
            placeholder="~/Documents/personal/projects"
          />
          <Button onClick={() => load(manual)}>Go</Button>
          <Button variant="default" disabled={busy || !listing} onClick={() => void pick(manual)}>
            Add this folder
          </Button>
        </div>
      }
    >
      {error ? <p className="mb-3 text-xs text-destructive">{error}</p> : null}
      <div className="mb-3 flex items-center gap-2">
        <Button variant="ghost" disabled={!listing?.parent} onClick={() => load(listing?.parent ?? undefined)}>
          ↑ Up
        </Button>
        <span className="truncate font-mono text-xs text-muted-foreground">{listing?.path ?? "…"}</span>
      </div>
      <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
        {listing?.entries.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-faint">No subfolders here</li>
        ) : null}
        {listing?.entries.map((entry) => (
          <li key={entry.path} className="flex items-center gap-2 px-3 py-2 hover:bg-accent">
            <Button
              variant="ghost"
              onClick={() => load(entry.path)}
              className="h-auto min-w-0 flex-1 justify-start truncate px-0 text-[13px] font-normal hover:bg-transparent"
            >
              {entry.name}
            </Button>
            {entry.isGit ? <Pill>git</Pill> : null}
            <Button variant="ghost" disabled={busy} onClick={() => void pick(entry.path)}>
              Add
            </Button>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
