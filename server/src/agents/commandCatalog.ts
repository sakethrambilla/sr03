// Provider-neutral cache + refresh + publish for slash commands, shared by claude.ts,
// cursor.ts and codex.ts so each adapter only supplies its own scan/probe.
import { dedupeByName } from "./skillScan.ts";
import type { ProviderId, ServerEvent, SlashCommand } from "../types.ts";

export interface CommandCatalog {
  list(cwd: string): Promise<SlashCommand[]>;
  refresh(cwd: string): Promise<void>;
  remember(cwd: string, commands: SlashCommand[]): void;
}

export function createCommandCatalog(options: {
  providerId: ProviderId;
  scan: (cwd: string) => Promise<SlashCommand[]>;
  probe: (cwd: string) => Promise<SlashCommand[]>;
  store: { get(id: string): { json: string } | null; set(id: string, json: string): void };
  publish: (event: ServerEvent) => void;
}): CommandCatalog {
  const { providerId, scan, probe, store, publish } = options;
  const key = (cwd: string) => `${providerId}:${cwd}`;

  function read(cwd: string): SlashCommand[] | null {
    const row = store.get(key(cwd));
    return row ? (JSON.parse(row.json) as SlashCommand[]) : null;
  }

  const inFlight = new Map<string, Promise<void>>();

  function refresh(cwd: string): Promise<void> {
    const existing = inFlight.get(cwd);
    if (existing) return existing;
    const pending = Promise.all([probe(cwd), scan(cwd)])
      .then(([live, scanned]) => {
        if (live.length === 0) return;
        const fresh = dedupeByName([live, scanned]);
        const freshJson = JSON.stringify(fresh);
        if (freshJson === store.get(key(cwd))?.json) return;
        store.set(key(cwd), freshJson);
        publish({ type: "commands.updated", providerId, cwd, commands: fresh });
      })
      .catch((error: Error) => console.error(`[commands:${providerId}] ${error.message ?? error}`))
      .finally(() => inFlight.delete(cwd));
    inFlight.set(cwd, pending);
    return pending;
  }

  async function list(cwd: string): Promise<SlashCommand[]> {
    const cached = read(cwd);
    const pending = refresh(cwd);
    if (cached) return cached;
    const scanned = await scan(cwd);
    if (scanned.length) {
      store.set(key(cwd), JSON.stringify(scanned));
      return scanned;
    }
    await pending;
    return read(cwd) ?? [];
  }

  function remember(cwd: string, commands: SlashCommand[]): void {
    store.set(key(cwd), JSON.stringify(commands));
  }

  return { list, refresh, remember };
}
