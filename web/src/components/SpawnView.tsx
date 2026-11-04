// The unsent "New agent" tab: a composer pinned to the parent thread's folder and branch, so the
// second agent shares its worktree. Only the provider's own pickers are live.
import { useState } from "react";

import type { Effort, PermissionMode, ProviderId, Thread } from "../lib/types.ts";
import { providerCatalog, tuneForModel, useStore } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { BranchIcon, Chip } from "./ui.tsx";

export function SpawnView({
  parent,
  providerId,
  onSent,
}: {
  parent: Thread;
  providerId: ProviderId;
  onSent: (thread: Thread) => void;
}) {
  const provider = useStore((state) => providerCatalog(state.providers, providerId));
  const spawnThread = useStore((state) => state.spawnThread);
  const [settings, setSettings] = useState(() => ({
    model: provider.defaults.model,
    permissionMode: provider.defaults.permissionMode as PermissionMode,
    ...tuneForModel(provider, provider.defaults.model, provider.defaults.effort),
  }));
  const [error, setError] = useState<string | null>(null);

  return (
    <Composer
      above={error ? <p className="px-1 text-xs text-destructive">{error}</p> : null}
      chips={
        <>
          {parent.branch ? <Chip icon={<BranchIcon className="size-3.5" />}>{parent.branch}</Chip> : null}
          <Chip icon={<ProviderLogo id={providerId} className="size-3.5" />}>{provider.label}</Chip>
        </>
      }
      cwd={parent.cwd}
      providerId={providerId}
      model={settings.model}
      permissionMode={settings.permissionMode}
      effort={settings.effort}
      fast={settings.fast}
      onModel={(model) =>
        setSettings((current) => ({ ...current, model, ...tuneForModel(provider, model, current.effort) }))
      }
      onPermissionMode={(permissionMode) => setSettings((current) => ({ ...current, permissionMode }))}
      onEffort={(effort: Effort) => setSettings((current) => ({ ...current, effort }))}
      onFast={(fast) => setSettings((current) => ({ ...current, fast }))}
      placeholder={`Ask ${provider.label}…`}
      onSubmit={async (text) => {
        setError(null);
        try {
          const thread = await spawnThread({ parentId: parent.id, providerId, ...settings, text });
          onSent(thread);
        } catch (caught) {
          setError((caught as Error).message);
          throw caught;
        }
      }}
    />
  );
}
