// Cross-platform executable lookup shared by provider probes. GUI launches get
// the login shell's PATH from the desktop wrapper, while explicit fallbacks cover common installers.
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

async function executable(candidate: string): Promise<boolean> {
  return fs.access(candidate, constants.X_OK).then(
    () => true,
    () => false,
  );
}

export async function findExecutable(
  names: string[],
  fallbacks: string[] = [],
): Promise<string | null> {
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];

  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidates =
        process.platform === "win32" && path.extname(name) === ""
          ? extensions.map((extension) => path.join(directory, `${name}${extension}`))
          : [path.join(directory, name)];
      for (const candidate of candidates) {
        if (await executable(candidate)) return candidate;
      }
    }
  }

  for (const candidate of fallbacks) {
    if (await executable(candidate)) return candidate;
  }
  return null;
}
