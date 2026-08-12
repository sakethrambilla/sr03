import { useEffect, useState } from "react";

import { sendClientMessage } from "../lib/ws.ts";
import { useStore } from "../store.ts";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "./ui.tsx";

// the mask keeps the middle transparent, so the ring sits on the button's own hover colour
const RING_MASK = "radial-gradient(closest-side, transparent 58%, black 60%)";

const hot = (percentage: number) => percentage >= 90;

function tokens(value: number): string {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${+(value / 1000).toFixed(1)}k`;
  return String(value);
}

function bytes(value: number): string {
  if (value >= 1 << 30) return `${(value / (1 << 30)).toFixed(1)} GB`;
  return `${Math.round(value / (1 << 20))} MB`;
}

function load(rss: number, cpu: number): string {
  return `${bytes(rss)} · ${cpu < 10 ? cpu.toFixed(1) : Math.round(cpu)}%`;
}

function money(value: number, currency?: string | null): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function since(at: number | null): string | null {
  if (!at) return null;
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function resets(at: number | null): string | null {
  if (!at) return null;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes <= 0) return "Resets now";
  if (minutes < 60) return `Resets in ${minutes} min`;
  if (minutes < 60 * 24) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `Resets in ${hours}h${rest ? ` ${rest}m` : ""}`;
  }
  return `Resets ${new Date(at).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

function Ring({ percentage }: { percentage: number }) {
  const filled = Math.max(0, Math.min(100, percentage));
  return (
    <span
      aria-hidden
      className="size-4 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(var(${hot(filled) ? "--destructive" : "--primary"}) ${filled}%, var(--border) 0)`,
        mask: RING_MASK,
        WebkitMask: RING_MASK,
      }}
    />
  );
}

function Meter({
  label,
  detail,
  percentage,
}: {
  label: string;
  detail?: string | null;
  percentage: number;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[12.5px]">{label}</span>
        <span className="shrink-0 text-[11px] text-faint">
          {detail ? <span className="mr-2">{detail}</span> : null}
          {Math.round(percentage)}%
        </span>
      </div>
      <Progress
        value={Math.min(100, Math.max(0, percentage))}
        className={cn(
          "mt-1.5 h-1 bg-accent",
          hot(percentage) && "[&_[data-slot=progress-indicator]]:bg-destructive",
        )}
      />
    </div>
  );
}

function Row({ label, hint, value }: { label: string; hint?: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="truncate text-[12.5px]">
        {label}
        {hint ? <span className="ml-1.5 text-[11px] text-faint">{hint}</span> : null}
      </span>
      <span className="shrink-0 text-[11px] text-faint">{value}</span>
    </div>
  );
}

// the process tree the server samples: its own children carry the cost of the agent and the
// terminals they belong to, which is what makes a heavy thread findable
function Resources() {
  const resources = useStore((state) => state.resources);
  if (!resources) return <p className="text-[12px] text-faint">Reading…</p>;
  const { total, server, shell, groups } = resources;
  return (
    <div className="space-y-1.5">
      <Row label="Everything" hint={`${total.processes} processes`} value={load(total.rss, total.cpu)} />
      {shell ? <Row label="App shell" value={load(shell.rss, shell.cpu)} /> : null}
      <Row label="Server" hint={`heap ${bytes(server.heapUsed)}`} value={load(server.rss, server.cpu)} />
      {groups.slice(0, 6).map((group) => (
        <Row
          key={group.id}
          label={group.title}
          hint={group.kind === "other" ? undefined : group.kind}
          value={load(group.rss, group.cpu)}
        />
      ))}
    </div>
  );
}

export function UsageMeter() {
  const usage = useStore((state) => state.usage);
  const refreshUsage = useStore((state) => state.refreshUsage);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    void refreshUsage();
    // sampling the process tree costs a `ps` every couple of seconds, so it runs only while
    // someone is watching it
    sendClientMessage({ type: "resources.watch", on: true });
    return () => sendClientMessage({ type: "resources.watch", on: false });
  }, [open, refreshUsage]);

  const context = usage?.context ?? null;
  const windows = usage?.windows ?? [];
  const credits = usage?.credits ?? null;
  const cost = usage?.sessionCostUsd ?? null;
  const read = open ? since(usage?.windowsAt ?? null) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Context and usage limits"
              className="size-7"
            >
              <Ring percentage={context?.percentage ?? 0} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {context ? `Context ${context.percentage}% used` : "Context and usage limits"}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" side="top" className="w-80">
        {!context && !windows.length ? (
          <p className="text-[12px] text-faint">No usage read yet — send a turn.</p>
        ) : (
          <>
            {context ? (
              <Meter
                label="Context window"
                detail={`${tokens(context.used)} / ${tokens(context.max)}`}
                percentage={context.percentage}
              />
            ) : (
              // an unread context is not an empty one, so it gets no bar to sit at zero
              <Row label="Context window" value="Not read yet" />
            )}
            {windows.length ? (
              <>
                <Separator className="my-3" />
                <div className="mb-2 flex items-baseline justify-between gap-3 text-[11px] text-faint">
                  <span className="truncate">
                    Your usage limits
                    {usage?.plan ? ` · ${usage.plan[0]!.toUpperCase()}${usage.plan.slice(1)}` : ""}
                  </span>
                  {read ? <span className="shrink-0">{read}</span> : null}
                </div>
                <div className="space-y-2.5">
                  {windows.map((window) => (
                    <Meter
                      key={window.id}
                      label={window.label}
                      detail={resets(window.resetsAt)}
                      percentage={window.utilization}
                    />
                  ))}
                </div>
              </>
            ) : null}
            {credits || cost ? (
              <>
                <Separator className="my-3" />
                <div className="space-y-1.5">
                  {credits ? (
                    <Row
                      label="Usage credits"
                      value={
                        credits.limit
                          ? `${money(credits.spent ?? 0, credits.currency)} / ${money(credits.limit, credits.currency)}`
                          : `${money(credits.spent ?? 0, credits.currency)} spent`
                      }
                    />
                  ) : null}
                  {cost ? <Row label="This thread" value={money(cost)} /> : null}
                </div>
              </>
            ) : null}
          </>
        )}
        <Separator className="my-3" />
        <div className="mb-2 text-[11px] text-faint">Resources</div>
        <Resources />
      </PopoverContent>
    </Popover>
  );
}
