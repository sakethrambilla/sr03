import type { ReactNode } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  EllipsisVertical,
  Folder,
  GitBranch,
  Mic,
  PanelLeft,
  X,
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
import { cn } from "@/lib/utils";

export { cn };

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
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

export function StatusDot({ status }: { status: "idle" | "running" | "error" }) {
  return (
    <span
      className={cn(
        "size-[7px] shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-primary",
        status === "error" && "bg-destructive",
        status === "idle" && "border border-faint/70",
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
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      onClick={onClick}
      title={title}
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-accent/40 px-2 text-[12px] text-muted-foreground",
        onClick && "cursor-pointer transition hover:border-border hover:text-foreground",
        className,
      )}
    >
      {icon}
      <span className="max-w-40 truncate">{children}</span>
    </Tag>
  );
}

const ICONS = {
  FolderIcon: Folder,
  BranchIcon: GitBranch,
  MicIcon: Mic,
  CloseIcon: X,
  DotsIcon: EllipsisVertical,
  SidebarIcon: PanelLeft,
  SendIcon: ArrowUp,
  CheckIcon: Check,
  ChevronIcon: ChevronDown,
} as const;

function icon(Source: LucideIcon) {
  return function Icon({ className }: { className?: string }) {
    return <Source strokeWidth={1.75} className={cn("size-3.5 shrink-0", className)} />;
  };
}

export const FolderIcon = icon(ICONS.FolderIcon);
export const BranchIcon = icon(ICONS.BranchIcon);
export const MicIcon = icon(ICONS.MicIcon);
export const CloseIcon = icon(ICONS.CloseIcon);
export const DotsIcon = icon(ICONS.DotsIcon);
export const SidebarIcon = icon(ICONS.SidebarIcon);
export const SendIcon = icon(ICONS.SendIcon);
export const CheckIcon = icon(ICONS.CheckIcon);
export const ChevronIcon = icon(ICONS.ChevronIcon);

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
