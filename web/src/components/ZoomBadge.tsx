import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { zoomPercent } from "@/lib/zoom.ts";

export function ZoomBadge() {
  const [factor, setFactor] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    const onZoom = (event: Event) => {
      setFactor((event as CustomEvent<number>).detail);
      setVisible(true);
      clearTimeout(timeout.current);
      timeout.current = setTimeout(() => setVisible(false), 1500);
    };
    window.addEventListener("sr03:zoom", onZoom);
    return () => {
      window.removeEventListener("sr03:zoom", onZoom);
      clearTimeout(timeout.current);
    };
  }, []);

  if (factor === null) return null;
  return (
    <Badge
      variant="outline"
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed top-3 right-3 z-50 rounded-md bg-popover px-2 py-1 text-[12px] tabular-nums text-muted-foreground shadow-sm transition-opacity duration-300",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      {zoomPercent(factor)}
    </Badge>
  );
}
