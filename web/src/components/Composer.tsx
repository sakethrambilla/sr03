// The prompt box, in two layers: `Composer` is the plain one the draft screen uses — textarea,
// attachments, dictation, slash-command menu, and the model / permission / effort pickers — and
// `ThreadComposer` wires it to a live thread, adding the tool-approval prompts above it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import type { Effort, PendingApproval, PermissionMode, SlashCommand, Thread } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { UsageMeter } from "./UsageMeter.tsx";
import { Button } from "@/components/ui/button";
import { Command, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CloseIcon,
  Menu,
  MicIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
  cn,
} from "./ui.tsx";

const NO_APPROVALS: PendingApproval[] = [];
const NO_COMMANDS: SlashCommand[] = [];

interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

const speech = window as unknown as {
  SpeechRecognition?: new () => Recognizer;
  webkitSpeechRecognition?: new () => Recognizer;
};
const Dictation = speech.SpeechRecognition ?? speech.webkitSpeechRecognition;

function EffortPicker({ effort, onPick }: { effort: Effort; onPick: (effort: Effort) => void }) {
  const levels = useStore((state) => state.effortLevels);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const selected = Math.max(
    0,
    levels.findIndex((level) => level.value === effort),
  );
  const index = dragging ?? selected;
  const current = levels[index];
  // the trigger tracks the committed level, so dragging doesn't flicker the row behind the popover
  const committed = levels[selected];

  const commit = (next: number) => {
    const level = levels[next];
    if (level && level.value !== effort) onPick(level.value);
  };

  // the dots sit in equal-width cells, so the pointer's cell is its level
  const indexAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return index;
    const cell = Math.floor(((clientX - rect.left) / rect.width) * levels.length);
    return Math.min(levels.length - 1, Math.max(0, cell));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          title="Reasoning effort"
          className="h-7 px-1.5 text-[12.5px] text-muted-foreground"
        >
          {committed?.label ?? effort}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-60">
          <div>
            <p className="text-[13px] text-muted-foreground">
              Effort <span className="font-medium text-foreground">{current?.label ?? effort}</span>
            </p>
            <div className="mt-2 flex justify-between text-[11px] text-faint">
              <span>Faster</span>
              <span>Smarter</span>
            </div>
            <div
              ref={trackRef}
              role="slider"
              tabIndex={0}
              aria-label="Reasoning effort"
              aria-valuemin={1}
              aria-valuemax={levels.length}
              aria-valuenow={index + 1}
              aria-valuetext={current?.label}
              onPointerDown={(event) => {
                setDragging(indexAt(event.clientX));
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (dragging === null) return;
                setDragging(indexAt(event.clientX));
              }}
              onPointerUp={(event) => {
                const next = dragging ?? indexAt(event.clientX);
                setDragging(null);
                commit(next);
              }}
              onPointerCancel={() => setDragging(null)}
              onKeyDown={(event) => {
                const step =
                  event.key === "ArrowLeft" || event.key === "ArrowDown"
                    ? -1
                    : event.key === "ArrowRight" || event.key === "ArrowUp"
                      ? 1
                      : 0;
                if (!step) return;
                event.preventDefault();
                commit(Math.min(levels.length - 1, Math.max(0, index + step)));
              }}
              className="mt-1 flex cursor-pointer touch-none items-center rounded-md bg-accent/60 py-2 outline-none select-none focus-visible:ring-1 focus-visible:ring-border"
            >
              {levels.map((level, at) => (
                <span
                  key={level.value}
                  title={`${level.label} — ${level.hint}`}
                  className="pointer-events-none grid flex-1 place-items-center"
                >
                  <span
                    className={cn(
                      // every dot keeps the same box and scales, so the panel can't grow mid-drag
                      "size-4 rounded-full transition-[transform,background-color]",
                      at === index ? "bg-foreground" : "scale-[0.375] bg-faint",
                    )}
                  />
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-faint">{current?.hint}</p>
          </div>
      </PopoverContent>
    </Popover>
  );
}

interface Attachment {
  id: string;
  name: string;
  path: string;
  url: string;
  isImage: boolean;
}

function ImageViewer({ item, onClose }: { item: Attachment; onClose: () => void }) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/80 p-8" onClick={onClose}>
      <img
        src={item.url}
        alt={item.name}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[85%] max-w-full rounded-lg border border-border object-contain"
      />
      <span className="font-mono text-[11px] text-muted-foreground">{item.name}</span>
    </div>
  );
}

// the CLI runs whatever text it is sent, so a command is picked by writing it into the box —
// the list only ever stands in for the name, and hands the caret back straight after
function CommandMenu({
  matches,
  active,
  onPick,
}: {
  matches: SlashCommand[];
  active: SlashCommand;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <Command
      shouldFilter={false}
      value={active.name}
      className="mb-2 rounded-lg border border-border bg-popover shadow-lg shadow-black/20"
    >
      <CommandList className="max-h-64 p-1">
        {matches.map((command) => (
          <CommandItem
            key={command.name}
            value={command.name}
            // the caret never leaves the box, so the click must not take focus with it
            onMouseDown={(event) => event.preventDefault()}
            onSelect={() => onPick(command)}
            className="gap-3"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-[12.5px]">
                /{command.name}
                {command.argumentHint ? (
                  <span className="text-faint"> {command.argumentHint}</span>
                ) : null}
              </span>
              {command.description ? (
                <span className="block truncate text-[11px] text-faint">{command.description}</span>
              ) : null}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

export function Composer({
  chips,
  above,
  cwd,
  model,
  permissionMode,
  effort,
  onModel,
  onPermissionMode,
  onEffort,
  placeholder,
  onSubmit,
  running,
  onInterrupt,
  blocked,
  restore,
}: {
  chips?: ReactNode;
  above?: ReactNode;
  cwd?: string;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  onModel: (model: string) => void;
  onPermissionMode: (mode: PermissionMode) => void;
  onEffort: (effort: Effort) => void;
  placeholder: string;
  onSubmit: (text: string) => void | Promise<void>;
  running?: boolean;
  onInterrupt?: () => void;
  blocked?: boolean;
  restore?: { text: string; key: number } | null;
}) {
  const models = useStore((state) => state.models);
  const permissionModes = useStore((state) => state.permissionModes);
  const setError = useStore((state) => state.setError);
  const loadCommands = useStore((state) => state.loadCommands);
  const commands = useStore((state) => (cwd ? state.commandsByCwd[cwd] : null) ?? NO_COMMANDS);
  const commandsLoaded = useStore((state) => (cwd ? state.commandsByCwd[cwd] !== undefined : false));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictationRef = useRef<Recognizer | null>(null);

  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => () => dictationRef.current?.stop(), []);

  // the key is what makes rewinding to the same message twice refill the box again
  useEffect(() => {
    if (!restore) return;
    setText(restore.text);
    inputRef.current?.focus();
  }, [restore?.key]);

  // the menu only stands in for the command name, so it goes away as soon as arguments start
  const typing = /^\/(\S*)$/.exec(text)?.[1] ?? null;
  const slashing = typing !== null;

  // a cold read spawns a CLI of its own, so the list is asked for on the first "/" rather than
  // on every mount — most sessions never type one
  useEffect(() => {
    if (cwd && slashing) void loadCommands(cwd);
  }, [cwd, slashing, loadCommands]);

  const matches = useMemo(() => {
    if (typing === null) return NO_COMMANDS;
    const needle = typing.toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().includes(needle));
  }, [typing, commands]);

  const menu = !dismissed && matches.length > 0;
  const active = matches[Math.min(picked, matches.length - 1)] ?? null;

  const pickCommand = (command: SlashCommand) => {
    setText(`/${command.name} `);
    setPicked(0);
    inputRef.current?.focus();
  };

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    if (!text) {
      input.style.height = "";
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }, [text]);

  const append = (value: string) => {
    setText((current) => (current.trim() ? `${current.trimEnd()} ${value}` : value));
    inputRef.current?.focus();
  };

  // dropped files land in the data dir; the message carries their paths so Claude can read them
  const addFiles = async (files: File[]) => {
    for (const file of files) {
      try {
        const saved = await api.upload(file);
        setAttachments((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            name: file.name || saved.name,
            path: saved.path,
            url: saved.url,
            isImage: file.type.startsWith("image/"),
          },
        ]);
      } catch (error) {
        setError((error as Error).message);
      }
    }
  };

  // the server shares this machine, so an attachment is just the file's path
  const attach = async () => {
    try {
      const chosen = await api.choosePath("file");
      if (chosen.path) append(`${chosen.path} `);
    } catch (error) {
      setError((error as Error).message);
    }
  };

  const toggleDictation = () => {
    if (!Dictation) return;
    if (listening) {
      dictationRef.current?.stop();
      return;
    }
    const dictation = new Dictation();
    dictation.lang = navigator.language;
    dictation.continuous = false;
    dictation.interimResults = false;
    dictation.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript?.trim();
      if (said) append(said);
    };
    dictation.onend = () => setListening(false);
    dictation.onerror = () => setListening(false);
    dictationRef.current = dictation;
    dictation.start();
    setListening(true);
  };

  const ready = Boolean(text.trim() || attachments.length);

  const submit = async () => {
    if (!ready || running || busy || blocked) return;
    const payload = [text.trim(), ...attachments.map((item) => item.path)].filter(Boolean).join("\n");
    setBusy(true);
    try {
      await onSubmit(payload);
      setText("");
      setAttachments([]);
    } catch {
      // the caller surfaces the failure; keep the text so it can be retried
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-5 pb-4">
      <div
        className="mx-auto max-w-3xl"
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length) void addFiles(files);
        }}
      >
        {above}
        {chips ? <div className="mb-2 flex flex-wrap items-center gap-1.5 empty:hidden">{chips}</div> : null}
        {menu && active ? (
          <CommandMenu matches={matches} active={active} onPick={pickCommand} />
        ) : slashing && !dismissed && !commandsLoaded ? (
          <p className="mb-2 px-2 text-[11px] text-faint">Reading commands…</p>
        ) : null}

        <div
          className={cn(
            "rounded-lg border bg-input/30 shadow-lg shadow-black/20 transition",
            dragging ? "border-primary" : "border-border focus-within:border-border/90",
          )}
        >
          {attachments.length ? (
            <div className="flex flex-wrap gap-1.5 px-3 pt-3">
              {attachments.map((item) => (
                <div key={item.id} className="group relative">
                  <Button
                    variant="outline"
                    onClick={() => (item.isImage ? setViewing(item) : undefined)}
                    title={item.isImage ? `View ${item.name}` : item.name}
                    className="size-14 overflow-hidden rounded-lg bg-background p-0"
                  >
                    {item.isImage ? (
                      <img src={item.url} alt={item.name} className="size-full object-cover" />
                    ) : (
                      <span className="grid size-full place-items-center px-1 font-mono text-[9px] break-all text-muted-foreground">
                        {item.name.slice(-10)}
                      </span>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}
                    aria-label={`Remove ${item.name}`}
                    className="absolute -top-1 -right-1 size-4 bg-card text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive"
                  >
                    <CloseIcon className="size-2.5" />
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-1.5 px-3 py-2.5">
            <Textarea
              ref={inputRef}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setPicked(0);
                setDismissed(false);
              }}
              onKeyDown={(event) => {
                if (menu && active) {
                  const step =
                    event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
                  if (step) {
                    event.preventDefault();
                    setPicked((current) => {
                      const at = Math.min(current, matches.length - 1) + step;
                      return (at + matches.length) % matches.length;
                    });
                    return;
                  }
                  if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    pickCommand(active);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setDismissed(true);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (!files.length) return;
                event.preventDefault();
                void addFiles(files);
              }}
              rows={1}
              placeholder={placeholder}
              className="max-h-[220px] min-h-8 w-full flex-1 resize-none rounded-none border-0 bg-transparent px-0 py-1.5 text-[14px] leading-relaxed shadow-none focus-visible:ring-0 placeholder:text-faint dark:bg-transparent"
            />
            {running && onInterrupt ? (
              <Button
                variant="outline"
                size="icon"
                onClick={onInterrupt}
                aria-label="Stop"
                className="mb-1 size-7 shrink-0"
              >
                <StopIcon className="size-3" />
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={ready && !blocked ? "default" : "ghost"}
                    size="icon"
                    onClick={() => void submit()}
                    disabled={!ready || busy || blocked}
                    aria-label="Send"
                    className="mb-1 size-7 shrink-0"
                  >
                    <SendIcon />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send (⏎)</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-0.5 px-1">
          <Menu
            title="Permission mode"
            heading="Mode"
            trigger={permissionModes.find((mode) => mode.value === permissionMode)?.label ?? permissionMode}
            items={permissionModes.map((mode) => ({
              id: mode.value,
              label: mode.label,
              hint: mode.hint,
              selected: mode.value === permissionMode,
            }))}
            onPick={(id) => onPermissionMode(id as PermissionMode)}
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void attach()}
            aria-label="Attach a file"
            className="size-7 text-faint"
          >
            <PlusIcon />
          </Button>
          {Dictation ? (
            <Toggle
              size="sm"
              pressed={listening}
              onPressedChange={toggleDictation}
              aria-label={listening ? "Stop dictation" : "Dictate a message"}
              className="size-7 min-w-7 text-faint data-[state=on]:text-primary"
            >
              <MicIcon />
            </Toggle>
          ) : null}
          <div className="flex-1" />
          <Menu
            align="end"
            title="Model"
            heading="Models"
            trigger={models.find((option) => option.slug === model || option.resolved === model)?.label ?? model}
            items={models.map((option) => ({
              id: option.slug,
              label: option.label,
              hint: option.hint,
              selected: option.slug === model,
            }))}
            onPick={onModel}
          />
          <EffortPicker effort={effort} onPick={onEffort} />
          <UsageMeter />
        </div>
      </div>

      {viewing ? <ImageViewer item={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

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
    <div className="mb-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2.5">
      <p className="text-[13px] font-medium">
        Allow <span className="font-mono text-primary">{approval.toolName}</span>?
      </p>
      <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{detail}</p>
      <div className="mt-2 flex gap-2">
        <Button variant="default" onClick={() => void respond(approval.id, "allow")}>
          Allow once
        </Button>
        <Button onClick={() => void respond(approval.id, "always")}>Always allow</Button>
        <Button variant="destructive" onClick={() => void respond(approval.id, "deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}

export function ThreadComposer({
  thread,
  restore,
}: {
  thread: Thread;
  restore?: { text: string; key: number } | null;
}) {
  const send = useStore((state) => state.send);
  const interrupt = useStore((state) => state.interrupt);
  const patchActive = useStore((state) => state.patchActive);
  const approvals = useStore((state) => state.approvalsByThread[thread.id] ?? NO_APPROVALS);
  const running = thread.status === "running";

  return (
    <Composer
      above={approvals.map((approval) => (
        <ApprovalPanel key={approval.id} approval={approval} />
      ))}
      cwd={thread.cwd}
      model={thread.model}
      permissionMode={thread.permissionMode}
      effort={thread.effort}
      onModel={(model) => void patchActive({ model })}
      onPermissionMode={(permissionMode) => void patchActive({ permissionMode })}
      onEffort={(effort) => void patchActive({ effort })}
      placeholder={running ? "Claude is working…" : "Ask Claude to change something…"}
      onSubmit={(text) => send(text)}
      running={running}
      onInterrupt={() => void interrupt()}
      restore={restore}
    />
  );
}
