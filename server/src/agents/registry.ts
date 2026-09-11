// Static provider registry. sr03 supports one local instance of each harness; threads persist the
// provider id and all runtime commands route through this map.
import type { ProviderId } from "../types.ts";
import { claudeProvider } from "./claude.ts";
import { cursorProvider } from "./cursor.ts";
import { codexProvider } from "./codex.ts";
import type { AgentProvider } from "./types.ts";

const providers: Record<ProviderId, AgentProvider> = {
  claude: claudeProvider,
  cursor: cursorProvider,
  codex: codexProvider,
};

export function providerFor(providerId: ProviderId): AgentProvider {
  return providers[providerId];
}
