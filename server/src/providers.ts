// What the settings page shows about Claude Code itself: whether the `claude` binary is on PATH,
// its version, which account is signed in, and the logout that hands off to the CLI's own.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { currentDefaults, EFFORT_LEVELS, listModels, PERMISSION_MODES } from "./models.ts";
import type { ModelOption } from "./models.ts";

const exec = promisify(execFile);

// what claude.ts hands the SDK; project and local resolve inside each session folder
const SETTING_SOURCES = ["user", "project", "local"];

export interface ProviderAccount {
  email: string | null;
  organization: string | null;
  plan: string | null;
}

export interface ProviderStatus {
  id: string;
  label: string;
  state: "ready" | "signed-out" | "missing";
  detail: string;
  version: string | null;
  binary: string | null;
  account: ProviderAccount | null;
  settingSources: string[];
  models: ModelOption[];
  defaults: { model: string; permissionMode: string; effort: string };
  signInHint: string;
}

// a GUI-launched app inherits a thin PATH, so fall back to where installers actually put it
const FALLBACK_BINS = [
  path.join(os.homedir(), ".local/bin/claude"),
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
];

async function findClaude(): Promise<string | null> {
  const found = await exec("which", ["claude"])
    .then(({ stdout }) => stdout.trim())
    .catch(() => "");
  if (found) return found;
  for (const candidate of FALLBACK_BINS) {
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return candidate;
  }
  return null;
}

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

// ~/.claude.json holds the signed-in profile; the tokens themselves live in the
// system keychain and are deliberately never read here
async function readAccount(): Promise<ProviderAccount | null> {
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


export async function listProviders(): Promise<ProviderStatus[]> {
  const binary = await findClaude();
  const [version, account] = await Promise.all([
    binary ? claudeVersion(binary) : Promise.resolve(null),
    readAccount(),
  ]);

  const state: ProviderStatus["state"] = !binary ? "missing" : account ? "ready" : "signed-out";
  const detail =
    state === "missing"
      ? "Claude Code (`claude`) was not found on PATH."
      : state === "signed-out"
        ? "Installed, but no account is signed in yet."
        : [account?.plan, account?.organization].filter(Boolean).join(" · ") || "Authenticated";

  return [
    {
      id: "claude",
      label: "Claude",
      state,
      detail,
      version,
      binary,
      account,
      settingSources: SETTING_SOURCES,
      models: await listModels(),
      defaults: currentDefaults(),
      // sr03 runs through the Agent SDK, which reuses the CLI's own login
      signInHint: "Run `claude auth login` in a terminal to sign in.",
    },
  ];
}

export const PROVIDER_OPTIONS = { permissionModes: PERMISSION_MODES, efforts: EFFORT_LEVELS };

// logout is the CLI's own `auth logout`, so the credentials are cleared the same way
// the CLI would clear them — this never touches the keychain directly
export async function logoutProvider(id: string): Promise<{ ok: boolean; output: string }> {
  if (id !== "claude") throw new Error(`Unknown provider: ${id}`);
  const binary = await findClaude();
  if (!binary) throw new Error("Claude Code (`claude`) was not found on PATH");
  try {
    const { stdout, stderr } = await exec(binary, ["auth", "logout"]);
    return { ok: true, output: (stdout || stderr).trim() };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    throw new Error((failure.stderr || failure.stdout || (error as Error).message).trim());
  }
}
