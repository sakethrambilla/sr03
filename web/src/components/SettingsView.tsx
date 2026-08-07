import { useEffect, useState } from "react";

import { api } from "../lib/api.ts";
import type { ProviderStatus } from "../lib/types.ts";
import { useStore } from "../store.ts";
import { CloseIcon, Dialog, RefreshIcon, SettingsIcon, cn } from "./ui.tsx";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

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
            <p className="mt-1.5 font-mono text-[12px] text-code-string">claude auth login</p>
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
            {provider.models.map((model) => (
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
        </div>

        <Separator />

        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 text-[11px] text-faint">
            Project and local settings resolve inside each session folder. Credentials stay in the
            system keychain — sr03 reuses the CLI's own login and never stores them itself.
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
            This runs <span className="font-mono text-foreground">claude auth logout</span>, which
            signs out the Claude Code CLI on this machine — not just sr03. Running sessions will
            stop working until you sign in again.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

export function SettingsView() {
  const setSettingsOpen = useStore((state) => state.setSettingsOpen);
  const [providers, setProviders] = useState<ProviderStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
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
  }, [tick]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setSettingsOpen]);

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col">
      <header data-titlebar className="flex items-center gap-2.5 border-b border-border/60 px-5 py-3">
        <SettingsIcon className="size-4 text-faint" />
        <h1 className="text-[13.5px] font-medium">
          Settings <span className="text-faint">/</span> Providers
        </h1>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTick((current) => current + 1)}
          aria-label="Re-check providers"
        >
          <RefreshIcon />
        </Button>
        <Button variant="ghost" onClick={() => setSettingsOpen(false)} aria-label="Close settings">
          <CloseIcon />
        </Button>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-2xl flex-col gap-4 px-6 py-6">
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
        </div>
      </div>
    </main>
  );
}
