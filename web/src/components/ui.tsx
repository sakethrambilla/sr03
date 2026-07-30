import type { ReactNode } from "react";
import { useState } from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  Code,
  EllipsisVertical,
  FileDiff,
  File,
  FileCode2,
  FilePlus,
  FileCog,
  FileImage,
  FileJson2,
  FileText,
  FileType,
  Folder,
  FolderPlus,
  GitBranch,
  MessageSquare,
  Mic,
  MousePointer2,
  PanelLeft,
  Plus,
  RefreshCw,
  Sparkles,
  Settings,
  Square,
  SquareStack,
  SquareTerminal,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog as ShadDialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export { cn };

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Badge variant="outline" className={cn("bg-card px-2 py-0.5 text-[11px] font-normal", className)}>
      {children}
    </Badge>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <ShadDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className={cn("max-h-[80vh] gap-0 overflow-hidden p-0", wide ? "sm:max-w-3xl" : "sm:max-w-xl")}
      >
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? <DialogFooter className="border-t border-border px-4 py-3">{footer}</DialogFooter> : null}
      </DialogContent>
    </ShadDialog>
  );
}

export function StatusDot({
  status,
  done,
}: {
  status: "idle" | "running" | "error";
  done?: boolean;
}) {
  return (
    <span
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-faint",
        status === "error" && "bg-destructive",
        status === "idle" && (done ? "bg-status-done" : "border border-faint/70"),
      )}
    />
  );
}

export function Chip({
  icon,
  children,
  className,
  onClick,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </>
  );
  const shape = cn(
    "h-7 gap-1.5 border-border/70 bg-accent/40 px-2 text-[12px] font-normal text-muted-foreground",
    className,
  );

  if (onClick) {
    return (
      <Button variant="outline" onClick={onClick} title={title} className={cn(shape, "shrink-0")}>
        {body}
      </Button>
    );
  }
  return (
    <Badge variant="outline" title={title} className={cn(shape, "shrink-0")}>
      {body}
    </Badge>
  );
}

const ICONS = {
  AgentIcon: Bot,
  FolderIcon: Folder,
  BranchIcon: GitBranch,
  MicIcon: Mic,
  CloseIcon: X,
  DotsIcon: EllipsisVertical,
  SidebarIcon: PanelLeft,
  SendIcon: ArrowUp,
  TerminalIcon: SquareTerminal,
  ChangesIcon: FileDiff,
  CodeIcon: Code,
  CheckIcon: Check,
  ChevronIcon: ChevronDown,
  RefreshIcon: RefreshCw,
  WorktreeIcon: SquareStack,
  SparkleIcon: Sparkles,
  PlusIcon: Plus,
  MessageIcon: MessageSquare,
  SettingsIcon: Settings,
  NewFileIcon: FilePlus,
  NewFolderIcon: FolderPlus,
  CollapseIcon: ChevronsDownUp,
  ExpandIcon: ChevronsUpDown,
  CursorIcon: MousePointer2,
  StopIcon: Square,
  ZedIcon: Zap,
} as const;

function icon(Source: LucideIcon) {
  return function Icon({ className }: { className?: string }) {
    return <Source strokeWidth={1.75} className={cn("size-3.5 shrink-0", className)} />;
  };
}

export const AgentIcon = icon(ICONS.AgentIcon);
export const FolderIcon = icon(ICONS.FolderIcon);
export const BranchIcon = icon(ICONS.BranchIcon);
export const MicIcon = icon(ICONS.MicIcon);
export const CloseIcon = icon(ICONS.CloseIcon);
export const DotsIcon = icon(ICONS.DotsIcon);
export const SidebarIcon = icon(ICONS.SidebarIcon);
export const SendIcon = icon(ICONS.SendIcon);
export const TerminalIcon = icon(ICONS.TerminalIcon);
export const ChangesIcon = icon(ICONS.ChangesIcon);
export const CodeIcon = icon(ICONS.CodeIcon);
export const CheckIcon = icon(ICONS.CheckIcon);
export const ChevronIcon = icon(ICONS.ChevronIcon);
export const RefreshIcon = icon(ICONS.RefreshIcon);
export const WorktreeIcon = icon(ICONS.WorktreeIcon);
export const SparkleIcon = icon(ICONS.SparkleIcon);
export const PlusIcon = icon(ICONS.PlusIcon);
export const MessageIcon = icon(ICONS.MessageIcon);
export const SettingsIcon = icon(ICONS.SettingsIcon);
export const NewFileIcon = icon(ICONS.NewFileIcon);
export const NewFolderIcon = icon(ICONS.NewFolderIcon);
export const CollapseIcon = icon(ICONS.CollapseIcon);
export const ExpandIcon = icon(ICONS.ExpandIcon);
export const CursorIcon = icon(ICONS.CursorIcon);
export const StopIcon = icon(ICONS.StopIcon);
export const ZedIcon = icon(ICONS.ZedIcon);

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  selected?: boolean;
}

export function Menu({
  trigger,
  title,
  heading,
  items,
  onPick,
  align = "start",
}: {
  trigger: string;
  title?: string;
  heading?: string;
  items: MenuItem[];
  onPick: (id: string) => void;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={title}
        className="flex h-7 shrink-0 items-center rounded-md px-1.5 text-[12.5px] text-muted-foreground transition outline-none hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
      >
        {trigger}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        side="top"
        className="min-w-56"
        onKeyDown={(event) => {
          const item = items[Number(event.key) - 1];
          if (!item || event.metaKey || event.ctrlKey || event.altKey) return;
          event.preventDefault();
          onPick(item.id);
        }}
      >
        {heading ? (
          <DropdownMenuLabel className="py-1 text-[11px] font-normal text-faint">
            {heading}
          </DropdownMenuLabel>
        ) : null}
        {items.map((item, index) => (
          <DropdownMenuItem key={item.id} onSelect={() => onPick(item.id)} className="gap-3">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px]">{item.label}</span>
              {item.hint ? (
                <span className="block truncate text-[11px] text-faint">{item.hint}</span>
              ) : null}
            </span>
            {item.selected ? <CheckIcon className="text-primary" /> : null}
            <DropdownMenuShortcut className="ml-0 tracking-normal">{index + 1}</DropdownMenuShortcut>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// small per-view preferences that should outlive a remount, but never reach the server
export function usePersistedState<T extends string | boolean>(
  key: string,
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(`sr03:${key}`);
    if (stored === null) return fallback;
    return (typeof fallback === "boolean" ? stored === "true" : stored) as T;
  });
  return [
    value,
    (next: T) => {
      localStorage.setItem(`sr03:${key}`, String(next));
      setValue(next);
    },
  ];
}

// file-type icons, mapped the way an editor's icon theme does: shape by kind, hue by family
const FILE_KINDS: Array<{ match: RegExp; Source: LucideIcon; tone: string }> = [
  { match: /\.(png|jpe?g|gif|webp|avif|ico|bmp|svg)$/i, Source: FileImage, tone: "text-file-style" },
  { match: /\.(css|scss|sass|less|woff2?|ttf|otf)$/i, Source: FileType, tone: "text-file-style" },
  { match: /\.(sh|bash|zsh|fish|ps1|bat|cmd)$/i, Source: SquareTerminal, tone: "text-file-shell" },
  { match: /(^\.env|^\.?[\w.-]*rc$|\.(toml|ini|conf|config)$)/i, Source: FileCog, tone: "text-file-data" },
  { match: /\.(json|jsonc|ya?ml|lock|xml|csv|tsv)$/i, Source: FileJson2, tone: "text-file-data" },
  { match: /\.(m?d|mdx|txt|pdf|log)$/i, Source: FileText, tone: "text-file-doc" },
  {
    match: /\.(tsx?|jsx?|m[jt]s|c[jt]s|html?|py|rs|go|java|rb|php|swift|kt|c|h|cpp|hpp|cs|sql|vue|svelte)$/i,
    Source: FileCode2,
    tone: "text-file-code",
  },
];

export function FileIcon({ name, muted }: { name: string; muted?: boolean }) {
  const kind = FILE_KINDS.find((candidate) => candidate.match.test(name));
  const Source = kind?.Source ?? File;
  return (
    <Source
      strokeWidth={1.75}
      className={cn("size-3.5 shrink-0", muted ? "text-git-ignored" : (kind?.tone ?? "text-faint"))}
    />
  );
}
