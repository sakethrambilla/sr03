// The excalidraw canvas embedded as a file preview. It owns no save logic of its own — every
// change is handed to the parent as a serialized string through the same onChange contract
// FileView's textarea uses, so ⌘S and the unsaved-tab dot work without FileView knowing this
// isn't a textarea.
import { Suspense, lazy, useEffect, useRef } from "react";
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";

import { resolveDark, systemPrefersDark } from "../lib/appearance.ts";
import { useStore } from "../store.ts";

// EXCALIDRAW_ASSET_PATH is read once, at module load, by the excalidraw bundle itself to
// resolve its canvas fonts (Virgil, Excalifont, …) — set it before that bundle is imported, or
// it falls back to fetching them from esm.sh, which fails offline and isn't on the CDN allowlist
declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}
window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");

let modulePromise: Promise<ExcalidrawModule> | null = null;
// held once resolved so a flush can serialize synchronously, without waiting on the promise again
let serialize: ExcalidrawModule["serializeAsJSON"] | null = null;
// the JS and its CSS are both ~150-500kb, so neither loads until a .excalidraw file is opened
function loadExcalidraw() {
  modulePromise ??= Promise.all([
    import("@excalidraw/excalidraw"),
    import("@excalidraw/excalidraw/index.css"),
  ]).then(([mod]) => {
    serialize = mod.serializeAsJSON;
    return mod;
  });
  return modulePromise;
}

const Excalidraw = lazy(() => loadExcalidraw().then((mod) => ({ default: mod.Excalidraw })));

// debounced past pointer moves and scroll, both of which fire onChange without changing the scene
const CHANGE_DEBOUNCE_MS = 300;

// an empty file (freshly created from the file tree) and a malformed one both read as a blank
// scene rather than throwing — the alternative is a permanently broken tab
function parseScene(text: string): ExcalidrawInitialDataState {
  if (!text.trim()) return { elements: [], appState: {} };
  try {
    const parsed = JSON.parse(text) as ExcalidrawInitialDataState;
    return { elements: parsed.elements ?? [], appState: parsed.appState ?? {}, files: parsed.files };
  } catch {
    return { elements: [], appState: {} };
  }
}

export function ExcalidrawView({
  text,
  dirty,
  onChange,
  onFlush,
}: {
  text: string;
  dirty: boolean;
  onChange: (next: string) => void;
  // handed a function that, if a debounced change is still waiting to fire, reports it right
  // now instead — the parent's only way to act on the canvas's true state without waiting out
  // the debounce below. returns whether it actually found (and reported) one
  onFlush: (flush: (() => boolean) | null) => void;
}) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  // whole-object selector, not just .mode — see the matching comment in Mermaid.tsx for why
  // (an OS flip under System mode changes the object reference but not the mode string)
  const appearance = useStore((state) => state.appearance);
  const dark = resolveDark(appearance.mode, systemPrefersDark());
  const initialData = useRef<ExcalidrawInitialDataState | null>(null);
  initialData.current ??= parseScene(text);
  const timer = useRef<number | null>(null);
  // excalidraw fires onChange once on mount as it settles the restored scene, re-versioning
  // elements in the process even with no edit behind it — comparing a fresh snapshot against
  // this baseline (rather than against the raw on-disk text, which never carries that
  // re-versioning) is what keeps a plain reopen-and-do-nothing from reading as unsaved
  const baseline = useRef<string | null>(null);

  const flush = (): string | null => {
    if (!api.current || !serialize) return null;
    return serialize(
      api.current.getSceneElementsIncludingDeleted(),
      api.current.getAppState(),
      api.current.getFiles(),
      "local",
    );
  };

  // compares a fresh snapshot to the baseline and reports it if different, moving the baseline
  // forward — shared by the debounce below and the on-demand flush, so both agree on what counts
  // as a change; the first call ever just establishes the baseline, per the comment above
  const commit = (): boolean => {
    const serialized = flush();
    if (serialized === null) return false;
    baseline.current ??= serialized;
    if (serialized === baseline.current) return false;
    baseline.current = serialized;
    onChange(serialized);
    return true;
  };

  // a no-op unless a debounced onChange is actually queued — otherwise this would re-run
  // commit()'s comparison for no reason and risk the exact re-versioning noise it exists to avoid
  const flushPending = (): boolean => {
    if (timer.current === null) return false;
    window.clearTimeout(timer.current);
    timer.current = null;
    return commit();
  };

  // registered once: flushPending reads api/serialize/timer fresh via refs/module state each
  // call, so the closure captured here never goes stale and never needs to be re-registered
  useEffect(() => {
    onFlush(flushPending);
    return () => onFlush(null);
  }, []);

  // an agent may have rewritten the file — follow it, but only while nothing here is unsaved,
  // matching the rule the textarea already follows for every other file kind. keyed on the text
  // prop itself rather than a change counter: a counter can tick one render before FileView's own
  // async reload actually lands the new text, which left this effect reading the stale value
  const firstText = useRef(true);
  useEffect(() => {
    if (firstText.current) {
      firstText.current = false;
      return;
    }
    if (dirty || !api.current) return;
    const scene = parseScene(text);
    // elements only — reapplying appState here would also reset the viewer's own
    // pan/zoom/selection, which a file change on disk has no business touching
    api.current.updateScene({ elements: scene.elements });
    if (scene.files) api.current.addFiles(Object.values(scene.files));
  }, [text, dirty]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="relative min-h-0 flex-1">
      <Suspense fallback={<p className="px-4 py-6 text-[12px] text-faint">Loading the canvas…</p>}>
        <Excalidraw
          excalidrawAPI={(instance) => {
            api.current = instance;
          }}
          initialData={initialData.current}
          theme={dark ? "dark" : "light"}
          UIOptions={{
            canvasActions: { saveToActiveFile: false, loadScene: false, toggleTheme: false },
          }}
          onChange={() => {
            if (timer.current) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
              timer.current = null;
              commit();
            }, CHANGE_DEBOUNCE_MS);
          }}
        />
      </Suspense>
    </div>
  );
}
