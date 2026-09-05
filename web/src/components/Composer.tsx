// The prompt box, in two layers: `Composer` is the plain one the draft screen uses — text box,
// attachments, dictation, slash-command menu, and the model / permission / effort pickers — and
// `ThreadComposer` wires it to a live thread, adding the tool-approval prompts above it.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { api } from "../lib/api.ts";
import type {
  Effort,
  EffortOption,
  ModelOption,
  PendingApproval,
  PendingQuestion,
  PermissionMode,
  ProviderId,
  Question,
  SlashCommand,
  Thread,
} from "../lib/types.ts";
import { commandKey, EMPTY_PROVIDER, findModel, useStore } from "../store.ts";
import { MentionInput } from "./MentionInput.tsx";
import type { MentionInputHandle } from "./MentionInput.tsx";
import { UsageMeter } from "./UsageMeter.tsx";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  CheckIcon,
  CloseIcon,
  FastIcon,
  Menu,
  MicIcon,
  PlusIcon,
  SendIcon,
  StopIcon,
  cn,
} from "./ui.tsx";

const NO_APPROVALS: PendingApproval[] = [];
const NO_QUESTIONS: PendingQuestion[] = [];
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

function EffortPicker({
  effort,
  levels,
  onPick,
  disabled,
}: {
  effort: Effort;
  levels: EffortOption[];
  onPick: (effort: Effort) => void;
  disabled?: boolean;
}) {
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
          disabled={disabled}
          title={disabled ? "Effort can change after this turn" : "Reasoning effort"}
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

function ModelPicker({
  model,
  models,
  disabled,
  title,
  onPick,
}: {
  model: string;
  models: ModelOption[];
  disabled?: boolean;
  title: string;
  onPick: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = findModel(models, model);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          title={title}
          // shrink + min-w-0 override Button's own shrink-0, so the label truncates instead of
          // spilling out of a narrow editor group
          className="h-7 max-w-44 min-w-0 shrink px-1.5 text-[12.5px] text-muted-foreground"
        >
          <span className="truncate">{selected?.label ?? model}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-72 p-0">
        <Command>
          {models.length > 8 ? <CommandInput placeholder="Search models…" /> : null}
          <CommandList className="max-h-80 p-1">
            <CommandEmpty className="py-4 text-center text-[12px] text-faint">No models</CommandEmpty>
            {models.map((option) => (
              <CommandItem
                key={option.slug}
                value={`${option.label} ${option.slug} ${option.hint}`}
                onSelect={() => {
                  onPick(option.slug);
                  setOpen(false);
                }}
                className="gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{option.label}</span>
                  {option.hint ? (
                    <span className="block truncate text-[11px] text-faint">{option.hint}</span>
                  ) : null}
                </span>
                {option === selected ? (
                  <CheckIcon className="text-primary" />
                ) : null}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
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
  providerId,
  model,
  permissionMode,
  effort,
  fast,
  onModel,
  onPermissionMode,
  onEffort,
  onFast,
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
  providerId: ProviderId;
  model: string;
  permissionMode: PermissionMode;
  effort: Effort;
  fast: boolean;
  onModel: (model: string) => void;
  onPermissionMode: (mode: PermissionMode) => void;
  onEffort: (effort: Effort) => void;
  onFast: (fast: boolean) => void;
  placeholder: string;
  onSubmit: (text: string) => void | Promise<void>;
  running?: boolean;
  onInterrupt?: () => void;
  blocked?: boolean;
  restore?: { text: string; key: number } | null;
}) {
  const provider = useStore(
    (state) => state.providers.find((entry) => entry.id === providerId) ?? EMPTY_PROVIDER,
  );
  const { models, permissionModes, capabilities } = provider;
  const selectedModel = findModel(models, model);
  // Cursor scopes both knobs to the model — Kimi K3 offers low/high/max and nothing between
  const effortLevels = selectedModel?.effortLevels ?? provider.effortLevels;
  const fastOption = selectedModel?.fast;
  const setError = useStore((state) => state.setError);
  const loadCommands = useStore((state) => state.loadCommands);
  const key = cwd ? commandKey(providerId, cwd) : null;
  const commands = useStore((state) => (key ? state.commandsByCwd[key] : null) ?? NO_COMMANDS);
  const commandsLoaded = useStore((state) => (key ? state.commandsByCwd[key] !== undefined : false));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<MentionInputHandle>(null);
  const dictationRef = useRef<Recognizer | null>(null);

  const [picked, setPicked] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => () => dictationRef.current?.stop(), []);

  // the key is what makes rewinding to the same message twice refill the box again
  useEffect(() => {
    if (!restore) return;
    inputRef.current?.setText(restore.text);
  }, [restore?.key]);

  // the menu only stands in for the command name, so it goes away as soon as arguments start
  const typing = capabilities.slashCommands ? (/^\/(\S*)$/.exec(text)?.[1] ?? null) : null;
  const slashing = typing !== null;

  // a cold read spawns a CLI of its own, so the list is asked for on the first "/" rather than
  // on every mount — most sessions never type one
  useEffect(() => {
    if (cwd && slashing) void loadCommands(providerId, cwd);
  }, [providerId, cwd, slashing, loadCommands]);

  const matches = useMemo(() => {
    if (typing === null) return NO_COMMANDS;
    const needle = typing.toLowerCase();
    return commands.filter((command) => command.name.toLowerCase().includes(needle));
  }, [typing, commands]);

  const menu = !dismissed && matches.length > 0;
  const active = matches[Math.min(picked, matches.length - 1)] ?? null;

  const pickCommand = (command: SlashCommand) => {
    inputRef.current?.setText(`/${command.name} `);
    setPicked(0);
  };

  const append = (value: string) => {
    inputRef.current?.setText(text.trim() ? `${text.trimEnd()} ${value}` : value);
  };

  // Dropped files land in the data dir; the message carries their paths so the provider can read them.
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
      inputRef.current?.setText("");
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
            <MentionInput
              ref={inputRef}
              placeholder={placeholder}
              onChange={(next) => {
                setText(next);
                setPicked(0);
                setDismissed(false);
              }}
              onSubmit={() => void submit()}
              onKeyDown={(event) => {
                if (!menu || !active) return;
                const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
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
                }
              }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (!files.length) return;
                event.preventDefault();
                void addFiles(files);
              }}
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

        {/* the controls are all shrink-0, so in a narrow editor group they wrap to a second line
            rather than spilling past the group's edge */}
        <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-0.5 px-1">
          {permissionModes.length > 0 ? (
            <Menu
              title={
                running && !capabilities.livePermissionModeSwitch
                  ? "Permission mode can change after this turn"
                  : "Permission mode"
              }
              heading="Mode"
              trigger={
                permissionModes.find((mode) => mode.value === permissionMode)?.label ??
                permissionMode
              }
              items={permissionModes.map((mode) => ({
                id: mode.value,
                label: mode.label,
                hint: mode.hint,
                selected: mode.value === permissionMode,
              }))}
              onPick={(id) => onPermissionMode(id as PermissionMode)}
              disabled={Boolean(running && !capabilities.livePermissionModeSwitch)}
            />
          ) : null}
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
          <ModelPicker
            model={model}
            models={models}
            title={
              running && !capabilities.liveModelSwitch
                ? "Model can change after this turn"
                : "Model"
            }
            onPick={onModel}
            disabled={Boolean(running && !capabilities.liveModelSwitch)}
          />
          {capabilities.effort && effortLevels.length >= 2 ? (
            <EffortPicker
              effort={effort}
              levels={effortLevels}
              onPick={onEffort}
              disabled={Boolean(running && !capabilities.liveEffortSwitch)}
            />
          ) : null}
          {capabilities.fast && fastOption ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  size="sm"
                  pressed={fast}
                  onPressedChange={onFast}
                  disabled={Boolean(running && !capabilities.liveFastSwitch)}
                  aria-label="Fast mode"
                  // TooltipTrigger asChild overwrites data-state, so the on-state must come from `fast`
                  className={cn("size-7 min-w-7", fast ? "text-git-added" : "text-faint")}
                >
                  <FastIcon />
                </Toggle>
              </TooltipTrigger>
              <TooltipContent>{fastOption.hint}</TooltipContent>
            </Tooltip>
          ) : null}
          <UsageMeter showProviderUsage={capabilities.usage} />
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
        {approval.decisions.includes("allow") ? (
          <Button variant="default" onClick={() => void respond(approval, "allow")}>
            Allow once
          </Button>
        ) : null}
        {approval.decisions.includes("always") ? (
          <Button onClick={() => void respond(approval, "always")}>Always allow</Button>
        ) : null}
        {approval.decisions.includes("deny") ? (
          <Button variant="destructive" onClick={() => void respond(approval, "deny")}>
            Deny
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function CursorQuestionPanel({ request }: { request: PendingQuestion }) {
  const answerQuestion = useStore((state) => state.answerQuestion);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const complete = request.questions.every((question) => (answers[question.id]?.length ?? 0) > 0);

  const pick = (questionId: string, optionId: string, multiple: boolean) => {
    setAnswers((current) => {
      if (!multiple) return { ...current, [questionId]: [optionId] };
      const selected = current[questionId] ?? [];
      return {
        ...current,
        [questionId]: selected.includes(optionId)
          ? selected.filter((id) => id !== optionId)
          : [...selected, optionId],
      };
    });
  };

  return (
    <div className="mb-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2.5">
      {request.title ? <p className="text-[13px] font-medium">{request.title}</p> : null}
      <div className="mt-1.5 flex flex-col gap-3">
        {request.questions.map((question) => (
          <div key={question.id}>
            <p className="text-[12.5px] text-foreground">{question.prompt}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {question.options.map((option) => {
                const selected = answers[question.id]?.includes(option.id) ?? false;
                return (
                  <Button
                    key={option.id}
                    variant={selected ? "default" : "outline"}
                    onClick={() => pick(question.id, option.id, question.allowMultiple)}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <Button
        className="mt-3"
        disabled={!complete}
        onClick={() => void answerQuestion(request.id, answers)}
      >
        Submit
      </Button>
    </div>
  );
}

interface Draft {
  selected: string[];
  custom: string;
}

const EMPTY_DRAFT: Draft = { selected: [], custom: "" };

// a typed answer wins over the options, so "Other" and a selection can never both be live;
// multi-select answers travel comma-separated, which is the shape the CLI reads them back in
function answerOf(draft: Draft): string {
  return draft.custom.trim() || draft.selected.join(", ");
}

// AskUserQuestion arrives through the same approval channel as any other tool, but it is answered
// rather than allowed — one question at a time, with the options as rows and a free-text way out
function QuestionPanel({ approval }: { approval: PendingApproval }) {
  const respond = useStore((state) => state.respond);
  const questions = approval.questions ?? [];
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [at, setAt] = useState(0);
  const [otherFor, setOtherFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const index = Math.min(at, questions.length - 1);
  const question = questions[index] as Question | undefined;
  const last = index === questions.length - 1;

  // the digit shortcuts only reach the panel if the composer does not hold the caret
  useEffect(() => panelRef.current?.focus(), []);

  const draft = (question && drafts[question.question]) ?? EMPTY_DRAFT;
  const answer = answerOf(draft);
  const otherOpen = question !== undefined && otherFor === question.question;

  const setDraft = (next: Draft) => {
    if (!question) return;
    setDrafts((current) => ({ ...current, [question.question]: next }));
  };

  const send = async (answers: Record<string, string>) => {
    setBusy(true);
    await respond(approval, { answers });
  };

  const advance = (answers: Record<string, string>) => {
    if (last) return void send(answers);
    setAt(index + 1);
    setOtherFor(null);
  };

  const pick = (label: string) => {
    if (!question || busy) return;
    const selected = question.multiSelect
      ? draft.selected.includes(label)
        ? draft.selected.filter((entry) => entry !== label)
        : [...draft.selected, label]
      : [label];
    setDraft({ selected, custom: "" });
    setOtherFor(null);
    // one choice is the whole answer, so a single-select question needs no confirm step
    if (!question.multiSelect) {
      advance({ ...collect(drafts, questions, index), [question.question]: label });
    }
  };

  const confirm = () => {
    if (!question || !answer || busy) return;
    advance({ ...collect(drafts, questions, index), [question.question]: answer });
  };

  if (!question) return null;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        const digit = Number(event.key);
        if (!Number.isInteger(digit) || digit < 1 || digit > question.options.length) return;
        event.preventDefault();
        pick(question.options[digit - 1]!.label);
      }}
      className="mb-2 rounded-lg border border-primary/50 bg-primary/10 px-3 py-2.5 outline-none"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-primary">{question.header}</span>
        <div className="flex-1" />
        {questions.length > 1 ? (
          <span className="text-[11px] tabular-nums text-faint">
            {index + 1}/{questions.length}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[13px] font-medium">{question.question}</p>
      {question.multiSelect ? (
        <p className="mt-0.5 text-[11px] text-faint">Pick one or more.</p>
      ) : null}

      <div className="mt-2 space-y-0.5">
        {question.options.map((option, position) => {
          const chosen = !draft.custom.trim() && draft.selected.includes(option.label);
          return (
            <button
              key={`${position}:${option.label}`}
              type="button"
              disabled={busy}
              onClick={() => pick(option.label)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors",
                chosen ? "bg-accent text-foreground" : "hover:bg-accent/50",
                busy && "opacity-50",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="block truncate text-[11px] text-faint">{option.description}</span>
                ) : null}
              </span>
              {chosen ? (
                <CheckIcon className="size-3.5 text-primary" />
              ) : position < 9 ? (
                <kbd className="text-[10px] tabular-nums text-faint">{position + 1}</kbd>
              ) : null}
            </button>
          );
        })}

        {otherOpen ? (
          <Input
            autoFocus
            value={draft.custom}
            onChange={(event) => setDraft({ selected: [], custom: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                confirm();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDraft({ ...draft, custom: "" });
                setOtherFor(null);
                panelRef.current?.focus();
              }
            }}
            placeholder="Your own answer…"
            className="h-8 text-[13px]"
          />
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => setOtherFor(question.question)}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-muted-foreground transition-colors hover:bg-accent/50"
          >
            <PlusIcon className="size-3" />
            Other…
          </button>
        )}
      </div>

      <div className="mt-2 flex gap-2">
        {question.multiSelect || otherOpen ? (
          <Button variant="default" disabled={!answer || busy} onClick={confirm}>
            {last ? "Send" : "Next"}
          </Button>
        ) : null}
        {index > 0 ? (
          <Button
            disabled={busy}
            onClick={() => {
              setAt(index - 1);
              setOtherFor(null);
            }}
          >
            Back
          </Button>
        ) : null}
        <Button disabled={busy} onClick={() => void respond(approval, "deny")}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

// every question before the current one is already answered, and they all travel together
function collect(
  drafts: Record<string, Draft>,
  questions: Question[],
  upTo: number,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const question of questions.slice(0, upTo)) {
    answers[question.question] = answerOf(drafts[question.question] ?? EMPTY_DRAFT);
  }
  return answers;
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
  const questions = useStore((state) => state.questionsByThread[thread.id] ?? NO_QUESTIONS);
  const provider = useStore(
    (state) => state.providers.find((entry) => entry.id === thread.providerId) ?? EMPTY_PROVIDER,
  );
  const running = thread.status === "running";
  const name = thread.providerId === "cursor" ? "Cursor" : "Claude";

  return (
    <Composer
      above={
        <>
          {approvals.map((approval) =>
            approval.questions ? (
              <QuestionPanel key={approval.id} approval={approval} />
            ) : (
              <ApprovalPanel key={approval.id} approval={approval} />
            ),
          )}
          {provider.capabilities.questions
            ? questions.map((question) => (
                <CursorQuestionPanel key={question.id} request={question} />
              ))
            : null}
        </>
      }
      cwd={thread.cwd}
      providerId={thread.providerId}
      model={thread.model}
      permissionMode={thread.permissionMode}
      effort={thread.effort}
      fast={thread.fast}
      onModel={(model) => void patchActive({ model })}
      onPermissionMode={(permissionMode) => void patchActive({ permissionMode })}
      onEffort={(effort) => void patchActive({ effort })}
      onFast={(fast) => void patchActive({ fast })}
      placeholder={running ? `${name} is working…` : `Ask ${name} to change something…`}
      onSubmit={(text) => send(text)}
      running={running}
      onInterrupt={() => void interrupt()}
      restore={restore}
    />
  );
}
