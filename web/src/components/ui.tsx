import type { ButtonHTMLAttributes, ReactNode } from "react";
import { useEffect } from "react";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "ghost" | "outline" | "danger";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-ink hover:brightness-110",
  ghost: "text-muted hover:bg-raised hover:text-ink",
  outline: "border border-line text-ink hover:bg-raised",
  danger: "text-danger hover:bg-danger/10",
};

export function Button({
  variant = "outline",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition disabled:pointer-events-none disabled:opacity-40",
        VARIANTS[variant],
        className,
      )}
    />
  );
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-line bg-panel px-2 py-0.5 text-[11px] text-muted",
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
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className={cn(
          "flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl",
          wide ? "max-w-3xl" : "max-w-xl",
        )}
      >
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer ? <footer className="border-t border-line px-4 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function StatusDot({ status }: { status: "idle" | "running" | "error" }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "running" && "animate-pulse bg-accent",
        status === "error" && "bg-danger",
        status === "idle" && "bg-faint",
      )}
    />
  );
}
