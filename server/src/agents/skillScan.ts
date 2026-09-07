// Shared filesystem discovery for the two on-disk layouts Claude Code and Cursor both use:
// a flat directory of `<name>.md` command files, and a directory of `<name>/SKILL.md` skill
// folders. Both file kinds share the same frontmatter shape (`---` fences around `key: value`
// lines), so both providers' scanners route through this module rather than each parsing
// their own copy.
import fs from "node:fs/promises";
import path from "node:path";

import type { SlashCommand } from "../types.ts";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

// top-level `key: value` lines only — no nested YAML. The two fields this project reads
// (description, argument-hint) are always flat, and a nested value would just be dropped.
export function parseFrontmatter(contents: string): Record<string, string> {
  const match = FRONTMATTER.exec(contents);
  if (!match?.[1]) return {};
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }
  return fields;
}

// Claude Code's custom-command layout: one `<root>/<name>.md` file per command.
export async function scanCommandFiles(root: string): Promise<SlashCommand[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const contents = await fs.readFile(path.join(root, entry.name), "utf8").catch(() => null);
    if (contents === null) continue;
    const frontmatter = parseFrontmatter(contents);
    commands.push({
      name: entry.name.slice(0, -3),
      description: frontmatter.description ?? "",
      argumentHint: frontmatter["argument-hint"] ?? "",
    });
  }
  return commands;
}

// The skill layout Claude Code and Cursor share: one `<root>/<name>/SKILL.md` per skill.
export async function scanSkillDirectories(root: string): Promise<SlashCommand[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const commands: SlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const contents = await fs
      .readFile(path.join(root, entry.name, "SKILL.md"), "utf8")
      .catch(() => null);
    if (contents === null) continue;
    const frontmatter = parseFrontmatter(contents);
    commands.push({
      name: entry.name,
      description: frontmatter.description ?? "",
      argumentHint: "",
    });
  }
  return commands;
}

// First list to carry a name wins, so callers order lists highest-precedence-first.
export function dedupeByName(lists: SlashCommand[][]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const list of lists) {
    for (const command of list) {
      if (!byName.has(command.name)) byName.set(command.name, command);
    }
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}
