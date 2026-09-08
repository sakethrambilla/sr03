// What the settings page shows about each local harness: installation, account, model catalog,
// and auth commands. Credentials remain owned by the CLIs and are never read or stored here.
//
// Probing a harness costs several child processes, so the last answer is cached in sqlite: a
// request is served from it at once and the fresh probe is pushed over the socket when it lands.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { publish } from "./bus.ts";
import { settings } from "./db.ts";
import { findExecutable } from "./executables.ts";
import { currentProvider, listModels } from "./models.ts";
import type { ProviderAccount, ProviderCatalog, ProviderId, ProviderStatus } from "./types.ts";

const exec = promisify(execFile);
const CLAUDE_SETTING_SOURCES = ["user", "project", "local"];
const CURSOR_SETTING_SOURCES = ["user", "project"];

const CLAUDE_FALLBACKS = [
  path.join(os.homedir(), ".local/bin/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

const CURSOR_FALLBACKS = [
  path.join(os.homedir(), ".local/bin/cursor-agent"),
  path.join(os.homedir(), ".local/bin/agent"),
  "/opt/homebrew/bin/cursor-agent",
  "/usr/local/bin/cursor-agent",
];

export const findClaude = () => findExecutable(["claude"], CLAUDE_FALLBACKS);
export const findCursor = () => findExecutable(["cursor-agent", "agent"], CURSOR_FALLBACKS);

async function claudeVersion(binary: string): Promise<string | null> {
  const { stdout } = await exec(binary, ["--version"]).catch(() => ({ stdout: "" }));
  return stdout.trim().split(/\s+/)[0] || null;
}

const PLANS: Record<string, string> = {
  claude_team: "Claude Team",
  claude_enterprise: "Claude Enterprise",
  claude_max: "Claude Max",
  claude_pro: "Claude Pro",
};

// ~/.claude.json holds profile metadata; the tokens themselves stay in the system keychain.
async function readClaudeAccount(): Promise<ProviderAccount | null> {
  const raw = await fs.readFile(path.join(os.homedir(), ".claude.json"), "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const account = (JSON.parse(raw) as { oauthAccount?: Record<string, unknown> }).oauthAccount;
    if (!account?.emailAddress) return null;
    const type = typeof account.organizationType === "string" ? account.organizationType : "";
    const subscription = account.billingType === "stripe_subscription" ? " Subscription" : "";
    return {
      email: String(account.emailAddress),
      organization:
        typeof account.organizationName === "string" ? account.organizationName : null,
      plan: type ? `${PLANS[type] ?? type}${subscription}` : null,
    };
  } catch {
    return null;
  }
}

async function claudeStatus(): Promise<ProviderStatus> {
  const binary = await findClaude();
  const [version, account] = await Promise.all([
    binary ? claudeVersion(binary) : Promise.resolve(null),
    readClaudeAccount(),
  ]);
  const state: ProviderStatus["state"] = !binary ? "missing" : account ? "ready" : "signed-out";
  if (binary) void listModels("claude");
  return {
    ...currentProvider("claude"),
    state,
    detail:
      state === "missing"
        ? "Claude Code (`claude`) was not found on PATH."
        : state === "signed-out"
          ? "Installed, but no account is signed in yet."
          : [account?.plan, account?.organization].filter(Boolean).join(" · ") || "Authenticated",
    version,
    binary,
    account,
    settingSources: CLAUDE_SETTING_SOURCES,
    signInHint: "Run this command in a terminal to sign in.",
    signInCommand: "claude auth login",
    logoutCommand: "claude auth logout",
  };
}

interface CursorAbout {
  cliVersion?: unknown;
  subscriptionTier?: unknown;
  userEmail?: unknown;
}

interface CursorAuth {
  status?: unknown;
  isAuthenticated?: unknown;
  userInfo?: { email?: unknown };
}

async function readCursor(binary: string): Promise<{
  version: string | null;
  account: ProviderAccount | null;
}> {
  const [about, status] = await Promise.all([
    exec(binary, ["about", "--format", "json"], {
      timeout: 8_000,
      maxBuffer: 1 << 20,
    }).catch(() => null),
    exec(binary, ["status", "--format", "json"], {
      timeout: 8_000,
      maxBuffer: 1 << 20,
    }).catch(() => null),
  ]);

  let details: CursorAbout = {};
  let auth: CursorAuth = {};
  try {
    details = about ? (JSON.parse(about.stdout) as CursorAbout) : {};
  } catch {
    details = {};
  }
  try {
    auth = status ? (JSON.parse(status.stdout) as CursorAuth) : {};
  } catch {
    auth = {};
  }

  const authenticated = auth.isAuthenticated === true || auth.status === "authenticated";
  const email =
    typeof details.userEmail === "string" && details.userEmail.trim()
      ? details.userEmail
      : typeof auth.userInfo?.email === "string"
        ? auth.userInfo.email
        : null;
  return {
    version: typeof details.cliVersion === "string" ? details.cliVersion : null,
    account:
      authenticated || email
        ? {
            email,
            organization: null,
            plan:
              typeof details.subscriptionTier === "string"
                ? `Cursor ${details.subscriptionTier}`
                : null,
          }
        : null,
  };
}

async function cursorStatus(): Promise<ProviderStatus> {
  const binary = await findCursor();
  const details = binary ? await readCursor(binary) : { version: null, account: null };
  const state: ProviderStatus["state"] = !binary
    ? "missing"
    : details.account
      ? "ready"
      : "signed-out";
  if (binary) void listModels("cursor");
  return {
    ...currentProvider("cursor"),
    state,
    detail:
      state === "missing"
        ? "Cursor Agent (`cursor-agent`) was not found on PATH."
        : state === "signed-out"
          ? "Installed, but no Cursor account is signed in yet."
          : details.account?.plan ?? "Authenticated",
    version: details.version,
    binary,
    account: details.account,
    settingSources: CURSOR_SETTING_SOURCES,
    signInHint: "Run this command in a terminal to sign in.",
    signInCommand: "cursor-agent login",
    logoutCommand: "cursor-agent logout",
  };
}

const PROVIDER_IDS: ProviderId[] = ["claude", "cursor"];

// Only the probed half is cached; the catalog half is rebuilt from the live model list on read,
// so a cached row can never resurrect a stale model catalog.
type ProviderProbe = Omit<ProviderStatus, keyof ProviderCatalog>;

const PROBE_KEY: Record<ProviderId, string> = {
  claude: "probe:claude",
  cursor: "probe:cursor",
};

function loadProbe(providerId: ProviderId): ProviderStatus | null {
  const raw = settings.all()[PROBE_KEY[providerId]];
  if (!raw) return null;
  try {
    const probe = JSON.parse(raw) as ProviderProbe;
    return typeof probe?.state === "string"
      ? { ...currentProvider(providerId), ...probe }
      : null;
  } catch {
    return null;
  }
}

function storeProbe(providerId: ProviderId, status: ProviderStatus): void {
  const probe: ProviderProbe = {
    state: status.state,
    detail: status.detail,
    version: status.version,
    binary: status.binary,
    account: status.account,
    settingSources: status.settingSources,
    signInHint: status.signInHint,
    signInCommand: status.signInCommand,
    logoutCommand: status.logoutCommand,
  };
  settings.set(PROBE_KEY[providerId], JSON.stringify(probe));
}

const probing: Partial<Record<ProviderId, Promise<ProviderStatus>>> = {};

// One probe per provider at a time; whoever asked next gets the same answer and every client
// gets it pushed.
function refreshProvider(providerId: ProviderId): Promise<ProviderStatus> {
  const existing = probing[providerId];
  if (existing) return existing;
  const reading = (providerId === "claude" ? claudeStatus() : cursorStatus())
    .then((status) => {
      storeProbe(providerId, status);
      publish({ type: "provider.status", status });
      return status;
    })
    .finally(() => {
      delete probing[providerId];
    });
  probing[providerId] = reading;
  return reading;
}

export async function listProviders(): Promise<ProviderStatus[]> {
  const cached = PROVIDER_IDS.map(loadProbe);
  const fresh = PROVIDER_IDS.map((providerId) => refreshProvider(providerId));
  if (cached.every((status) => status !== null)) {
    for (const reading of fresh) {
      reading.catch((error: Error) => console.error(`[providers] ${error.message}`));
    }
    return cached as ProviderStatus[];
  }
  return Promise.all(PROVIDER_IDS.map((_, index) => cached[index] ?? fresh[index]!));
}

// Logout is delegated to the selected CLI so it clears the same credentials as its own client.
export async function logoutProvider(id: string): Promise<{ ok: boolean; output: string }> {
  if (id !== "claude" && id !== "cursor") throw new Error(`Unknown provider: ${id}`);
  const providerId: ProviderId = id;
  const binary = providerId === "claude" ? await findClaude() : await findCursor();
  if (!binary) throw new Error(`${currentProvider(providerId).label} was not found on PATH`);
  const args = providerId === "claude" ? ["auth", "logout"] : ["logout"];
  try {
    const { stdout, stderr } = await exec(binary, args);
    return { ok: true, output: (stdout || stderr).trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error((failure.stderr || failure.stdout || (error as Error).message).trim());
  }
}
