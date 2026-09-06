// The settings page — a view beside the sessions rather than a layer over them. Two sections:
// local provider status/catalogs and the appearance panel.
import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api.ts";
import { THEMES, availableFonts } from "../lib/appearance.ts";
import type { ThemeMode } from "../lib/appearance.ts";
import type { PermissionMode, ProviderStatus } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { SidebarToggle } from "./Sidebar.tsx";
import {
  CheckIcon,
  CloseIcon,
  Dialog,
  RefreshIcon,
  SettingsIcon,
  cn,
  usePersistedState,
} from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const STATE_STYLE: Record<ProviderStatus["state"], { dot: string; label: string }> = {
  ready: { dot: "bg-git-added", label: "Authenticated" },
  "signed-out": { dot: "bg-git-modified", label: "Not signed in" },
  missing: { dot: "bg-destructive", label: "Not found" },
};

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={cn("text-[13px] text-foreground", mono && "font-mono text-[12px]")}>{value}</span>
    </div>
  );
}

function ProviderCard({
  provider,
  onChanged,
}: {
  provider: ProviderStatus;
  onChanged: () => void;
}) {
  const style = STATE_STYLE[provider.state];
  const [confirming, setConfirming] = useState(false);
  const [showAllModels, setShowAllModels] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const logout = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await api.logoutProvider(provider.id);
      setConfirming(false);
      onChanged();
    } catch (cause) {
      setFailure((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-border/70 bg-card/40">
      <header className="flex items-center gap-2.5 border-b border-border/60 px-4 py-3">
        <h2 className="text-[14px] font-medium">{provider.label}</h2>
        {provider.version ? (
          <span className="font-mono text-[11px] text-faint">v{provider.version}</span>
        ) : null}
        <div className="flex-1" />
        <span className={cn("size-1.5 rounded-full", style.dot)} />
        <span className="text-[12px] text-muted-foreground">{style.label}</span>
      </header>

      <div className="flex flex-col gap-4 px-4 py-4">
        <p className="text-[13px] text-muted-foreground">{provider.detail}</p>

        {provider.state !== "ready" ? (
          <div className="rounded-md border border-border/70 bg-background px-3 py-2.5">
            <p className="text-[12px] text-muted-foreground">{provider.signInHint}</p>
            <p className="mt-1.5 font-mono text-[12px] text-code-string">
              {provider.signInCommand}
            </p>
          </div>
        ) : null}

        {failure ? <p className="text-[12px] text-destructive">{failure}</p> : null}

        {provider.account ? (
          <div className="grid grid-cols-2 gap-4">
            {provider.account.email ? <Field label="Account" value={provider.account.email} /> : null}
            {provider.account.organization ? (
              <Field label="Organization" value={provider.account.organization} />
            ) : null}
            {provider.account.plan ? <Field label="Plan" value={provider.account.plan} /> : null}
          </div>
        ) : null}

        <Separator />

        <div className="grid grid-cols-2 gap-4">
          <Field label="Binary path" value={provider.binary ?? "not on PATH"} mono />
          <Field label="Settings honored" value={provider.settingSources.join(", ")} mono />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] text-muted-foreground">Models</span>
          <ul className="flex flex-col gap-1">
            {(showAllModels ? provider.models : provider.models.slice(0, 12)).map((model) => (
              <li key={model.slug} className="flex items-center gap-2 text-[13px]">
                <span className="text-foreground">{model.label}</span>
                <span className="font-mono text-[11px] text-faint">{model.slug}</span>
                {model.slug === provider.defaults.model ? (
                  <span className="rounded border border-border/70 px-1 text-[10.5px] text-muted-foreground">
                    default
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {provider.models.length > 12 ? (
            <Button
              variant="ghost"
              onClick={() => setShowAllModels((current) => !current)}
              className="mt-1 self-start px-1.5 text-faint"
            >
              {showAllModels ? "Show fewer" : `Show all ${provider.models.length}`}
            </Button>
          ) : null}
        </div>

        <Separator />

        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[11px] text-faint">
            Project and local settings resolve inside each session folder. Credentials stay in the
            provider's own credential store — sr03 reuses the CLI login and never stores it itself.
          </p>
          {provider.state === "ready" ? (
            <Button
              variant="outline"
              onClick={() => setConfirming(true)}
              className="shrink-0 text-destructive"
            >
              Log out
            </Button>
          ) : null}
        </div>
      </div>

      {confirming ? (
        <Dialog
          title={`Log out of ${provider.label}?`}
          onClose={() => setConfirming(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => void logout()}>
                {busy ? "Logging out…" : "Log out"}
              </Button>
            </div>
          }
        >
          <p className="text-[13px] text-muted-foreground">
            This runs{" "}
            <span className="font-mono text-foreground">{provider.logoutCommand}</span>, which
            signs out {provider.label} on this machine — not just sr03. Running sessions may stop
            working until you sign in again.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

// each swatch renders under its own data-theme, so the preview is drawn by the very tokens
// the theme defines rather than by a second copy of the palette in here
function ThemeSwatch({ id, label, selected, onPick }: {
  id: string;
  label: string;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      data-theme={id}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-2 text-left transition bg-background",
        selected ? "border-primary" : "border-border hover:border-muted-foreground",
      )}
    >
      <span className="flex h-10 items-stretch gap-1 overflow-hidden rounded-md">
        <span className="w-1/4 rounded-sm bg-card" />
        <span className="flex-1 rounded-sm bg-accent" />
        <span className="w-1/4 rounded-sm bg-primary" />
      </span>
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{label}</span>
        {selected ? <CheckIcon className="size-3 text-primary" /> : null}
      </span>
    </button>
  );
}

function FontPicker({ label, hint, value, options, onPick }: {
  label: string;
  hint: string;
  value: string;
  options: string[];
  onPick: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-foreground">{label}</p>
        <p className="text-[11.5px] text-faint">{hint}</p>
      </div>
      <Select value={value || "system"} onValueChange={(next) => onPick(next === "system" ? "" : next)}>
        <SelectTrigger className="w-56 shrink-0">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">System default</SelectItem>
          {options.map((font) => (
            <SelectItem key={font} value={font} style={{ fontFamily: `"${font}"` }}>
              {font}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function GeneralPanel() {
  const providers = useStore((state) => state.providers);
  const defaultProviderId = useStore((state) => state.defaultProviderId);
  const permissionModes =
    providers.find((provider) => provider.id === defaultProviderId)?.permissionModes ?? [];
  const defaultPermissionMode = useStore((state) => state.defaults.permissionMode);
  const setDefaultPermissionMode = useStore((state) => state.setDefaultPermissionMode);

  return (
    <section className="rounded-lg border border-border/70 bg-card/40">
      <header className="border-b border-border/60 px-4 py-3">
        <h2 className="text-[14px] font-medium">Session defaults</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Applied to every new session started on this machine from now on. Sessions already
          open keep whatever mode they were started with.
        </p>
      </header>
      <div className="flex items-center gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-foreground">Permission mode</p>
          <p className="text-[11.5px] text-faint">How much a new session can do without asking</p>
        </div>
        <Select
          value={defaultPermissionMode}
          onValueChange={(next) => void setDefaultPermissionMode(next as PermissionMode)}
        >
          <SelectTrigger className="w-56 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {permissionModes.map((mode) => (
              <SelectItem key={mode.value} value={mode.value}>
                {mode.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </section>
  );
}

function EditorPanel() {
  const [autoPreview, setAutoPreview] = usePersistedState<boolean>("auto-preview", true);

  return (
    <section className="rounded-lg border border-border/70 bg-card/40">
      <header className="border-b border-border/60 px-4 py-3">
        <h2 className="text-[14px] font-medium">Editor</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          Applies to files opened from now on. Files already open keep their current view.
        </p>
      </header>
      <div className="flex items-center gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-foreground">Open diagrams in preview</p>
          <p className="text-[11.5px] text-faint">
            A .mmd or .excalidraw file opens rendered, not as its raw source
          </p>
        </div>
        <Switch checked={autoPreview} onCheckedChange={setAutoPreview} />
      </div>
    </section>
  );
}

function AppearancePanel() {
  const appearance = useStore((state) => state.appearance);
  const setAppearance = useStore((state) => state.setAppearance);
  // measuring every candidate touches the canvas, so the answer is worked out once
  const fonts = useMemo(() => availableFonts(), []);

  return (
    <>
      <section className="rounded-lg border border-border/70 bg-card/40">
        <header className="border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-medium">Theme</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            The shadcn palettes. Diff, syntax and file-icon colors keep their editor meaning in
            every one.
          </p>
        </header>
        <div className="flex items-center gap-4 border-b border-border/60 px-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-foreground">Mode</p>
            <p className="text-[11.5px] text-faint">Light, dark, or match the system setting</p>
          </div>
          <Select
            value={appearance.mode}
            onValueChange={(next) => setAppearance({ mode: next as ThemeMode })}
          >
            <SelectTrigger className="w-56 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">Light</SelectItem>
              <SelectItem value="dark">Dark</SelectItem>
              <SelectItem value="system">System</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-4 gap-2.5 px-4 py-4">
          {THEMES.map((theme) => (
            <ThemeSwatch
              key={theme.id}
              id={theme.id}
              label={theme.label}
              selected={appearance.theme === theme.id}
              onPick={() => setAppearance({ theme: theme.id })}
            />
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border/70 bg-card/40">
        <header className="border-b border-border/60 px-4 py-3">
          <h2 className="text-[14px] font-medium">Fonts</h2>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Only faces installed on this machine are listed.
          </p>
        </header>
        <div className="flex flex-col gap-4 px-4 py-4">
          <FontPicker
            label="Interface"
            hint="Everything that isn't code"
            value={appearance.uiFont}
            options={fonts.ui}
            onPick={(uiFont) => setAppearance({ uiFont })}
          />
          <Separator />
          <FontPicker
            label="Code"
            hint="Editor, diffs, code blocks and the terminal"
            value={appearance.codeFont}
            options={fonts.code}
            onPick={(codeFont) => setAppearance({ codeFont })}
          />
          <div className="rounded-md border border-border/70 bg-background px-3 py-2.5">
            <pre className="overflow-x-auto font-mono text-[12.5px] leading-relaxed">
              <span className="text-code-keyword">const</span>{" "}
              <span className="text-code-function">greet</span> = (
              <span className="text-code-property">name</span>) =&gt;{" "}
              <span className="text-code-string">{"`hi ${name}`"}</span>;
            </pre>
          </div>
        </div>
      </section>
    </>
  );
}

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "appearance", label: "Appearance" },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

export function SettingsView() {
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const catalogs = useStore((state) => state.providers);
  const defaultProviderId = useStore((state) => state.defaultProviderId);
  const refreshState = useStore((state) => state.refreshState);
  const [section, setSection] = usePersistedState<Section>("settings-section", "general");
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (section !== "providers") return;
    let cancelled = false;
    api
      .providers()
      .then((next) => {
        if (!cancelled) {
          setProviders(next.providers);
          setError(null);
        }
      })
      .catch((cause: Error) => {
        if (!cancelled) setError(cause.message);
      });
    return () => {
      cancelled = true;
    };
  }, [tick, section]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSettingsOpen]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <header data-titlebar className="flex h-15 shrink-0 items-center gap-2.5 border-b border-border/60 px-5">
        <SidebarToggle />
        <SettingsIcon className="size-4 text-faint" />
        <h1 className="text-[13.5px] font-medium">
          Settings <span className="text-faint">/</span>{" "}
          {SECTIONS.find((entry) => entry.id === section)?.label}
        </h1>
        <div className="flex-1" />
        {section === "providers" ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTick((current) => current + 1)}
            aria-label="Re-check providers"
          >
            <RefreshIcon />
          </Button>
        ) : null}
        <Button variant="ghost" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
          <CloseIcon />
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border/60 px-2 py-4">
          {SECTIONS.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setSection(entry.id)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-left text-[13px] transition",
                entry.id === section
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              )}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
            {section === "general" ? (
              <>
                <GeneralPanel />
                <EditorPanel />
              </>
            ) : null}
            {section === "appearance" ? <AppearancePanel /> : null}
            {section === "providers" ? (
              <>
                <section className="rounded-lg border border-border/70 bg-card/40 px-4 py-3">
                  <div className="flex items-center gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-foreground">Default provider</p>
                      <p className="text-[11.5px] text-faint">
                        Used for each new session; existing sessions keep their provider.
                      </p>
                    </div>
                    <Select
                      value={defaultProviderId}
                      onValueChange={(value) => {
                        void api
                          .saveSetting("defaultProviderId", value)
                          .then(() => refreshState())
                          .catch((cause: Error) => setError(cause.message));
                      }}
                    >
                      <SelectTrigger className="w-44 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {catalogs.map((provider) => (
                          <SelectItem key={provider.id} value={provider.id}>
                            {provider.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </section>
                {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
                {providers === null && !error ? (
                  <p className="text-[12px] text-faint">Checking…</p>
                ) : null}
                {providers?.map((provider) => (
                  <ProviderCard
                    key={provider.id}
                    provider={provider}
                    onChanged={() => setTick((current) => current + 1)}
                  />
                ))}
              </>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}
