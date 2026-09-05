// Renders a mermaid diagram from its source text. Used by both the .mmd file preview and any
// ```mermaid fence in markdown (assistant replies and .md previews share the same component).
import { useEffect, useState } from "react";
import type { Mermaid as MermaidApi } from "mermaid";

import { useStore } from "../store.ts";
import { cn } from "./ui.tsx";

// debounced past a keystroke so retyping doesn't queue a render per character
const RENDER_DEBOUNCE_MS = 250;

let engine: Promise<MermaidApi> | null = null;
function loadMermaid(): Promise<MermaidApi> {
  engine ??= import("mermaid").then((mod) => mod.default);
  return engine;
}

let renderId = 0;

// sr03's tokens are oklch(), which the browser renders fine but mermaid's own color parser
// (khroma) doesn't understand. Neither fillStyle nor getComputedStyle downgrade oklch() back
// to rgb() in current Chromium — only actually rasterizing it and reading the pixel back does
let probe: CanvasRenderingContext2D | null = null;
function toRgb(color: string): string {
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return color;
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

// sr03 has no light theme (see index.html's fixed `class="dark"`), so this only has to track
// the current accent — read straight off the live tokens rather than hand-maintaining a palette.
// cached per theme id so retyping a diagram doesn't re-rasterize seven colors on every keystroke
let cache: { theme: string; variables: Record<string, string> } | null = null;
function themeVariables(theme: string): Record<string, string> {
  if (cache?.theme === theme) return cache.variables;
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => toRgb(style.getPropertyValue(name).trim());
  const variables = {
    background: token("--background"),
    mainBkg: token("--card"),
    primaryColor: token("--card"),
    primaryTextColor: token("--foreground"),
    primaryBorderColor: token("--border"),
    secondaryColor: token("--secondary"),
    tertiaryColor: token("--accent"),
    lineColor: token("--muted-foreground"),
    textColor: token("--foreground"),
    nodeTextColor: token("--foreground"),
    edgeLabelBackground: token("--card"),
    errorBkgColor: token("--destructive"),
    errorTextColor: token("--destructive-foreground"),
    fontFamily: style.getPropertyValue("--font-mono").trim() || "monospace",
  };
  cache = { theme, variables };
  return variables;
}

export function Mermaid({ source, className }: { source: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // an already-rendered diagram has no other reason to re-run once its source stops changing,
  // so a theme/accent switch needs to be its own dependency to ever repaint it
  const theme = useStore((state) => state.appearance.theme);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      const trimmed = source.trim();
      if (!trimmed) {
        setSvg(null);
        setError(null);
        return;
      }
      void (async () => {
        try {
          const mermaid = await loadMermaid();
          if (controller.signal.aborted) return;
          mermaid.initialize({
            startOnLoad: false,
            suppressErrorRendering: true,
            securityLevel: "strict",
            theme: "base",
            themeVariables: themeVariables(theme),
          });
          await mermaid.parse(trimmed);
          if (controller.signal.aborted) return;
          const { svg: rendered } = await mermaid.render(`mermaid-${++renderId}`, trimmed);
          if (controller.signal.aborted) return;
          setSvg(rendered);
          setError(null);
        } catch (cause) {
          if (controller.signal.aborted) return;
          // the last good diagram stays up (dimmed below), so a typo doesn't blank the canvas
          setError((cause as Error).message);
        }
      })();
    }, RENDER_DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [source, theme]);

  if (!svg && !error) {
    return <p className={cn("text-[12px] text-faint", className)}>Nothing to render yet.</p>;
  }

  return (
    <div className={cn("space-y-3", className)}>
      {error ? (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-destructive">
          {error}
        </p>
      ) : null}
      {svg ? (
        <div
          className={cn("overflow-x-auto [&_svg]:h-auto [&_svg]:max-w-full", error && "opacity-50")}
          // mermaid runs its own sanitizer under securityLevel: "strict" before this ever renders
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : null}
    </div>
  );
}
