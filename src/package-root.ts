import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The checkout or installed package, found from this file whether it runs
// from src/ or dist/src/.
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, "utf8")) as { name?: string }).name === "badbot"
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("can't find badbot's package.json");
    dir = parent;
  }
}
