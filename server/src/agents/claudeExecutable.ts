import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+(\.\d+)*$/;

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => parseInt(part, 10));
  const b = right.split(".").map((part) => parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function pickClaudeExecutable(input: {
  machine: string | null;
  machineVersion: string | null;
  bundledVersion: string;
  platform: NodeJS.Platform;
}): string | undefined {
  const { machine, machineVersion, bundledVersion, platform } = input;
  if (!machine || !machineVersion || !VERSION.test(machineVersion)) return undefined;
  if (platform === "win32" && !machine.toLowerCase().endsWith(".exe")) return undefined;
  return compareVersions(machineVersion, bundledVersion) >= 0 ? machine : undefined;
}

function bundledClaudeVersion(): string {
  const sdk = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(sdk), "package.json"), "utf8"));
  return String(manifest.claudeCodeVersion);
}

let picked: Promise<string | undefined> | undefined;

// the SDK speaks a versioned protocol, so an older machine CLI loses to the bundled one
export function claudeExecutable(): Promise<string | undefined> {
  picked ??= (async () => {
    try {
      const { claudeVersion, findClaude } = await import("../providers.ts");
      const machine = await findClaude();
      const machineVersion = machine ? await claudeVersion(machine) : null;
      const result = pickClaudeExecutable({
        machine,
        machineVersion,
        bundledVersion: bundledClaudeVersion(),
        platform: process.platform,
      });
      if (machine && !(machineVersion && VERSION.test(machineVersion))) {
        console.error(`[claude] couldn't read ${machine} --version; using the bundled CLI`);
      } else {
        console.log(`[claude] using ${result ?? "bundled"} CLI`);
      }
      return result;
    } catch (error) {
      console.error(`[claude] ${(error as Error).message}; using the bundled CLI`);
      return undefined;
    }
  })();
  return picked;
}
