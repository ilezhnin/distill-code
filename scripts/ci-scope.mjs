// Unknown changes conservatively run both compile gates. Docs and frontend-only
// changes must not pay for native compilation and unrelated integration tests.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function scopeForPaths(paths) {
  let frontend = false;
  let native = false;
  for (const path of paths) {
    if (/^(?:docs\/|.*\.md$|LICENSE$|NOTICE$)/.test(path)) continue;
    if (/^src-tauri\//.test(path)) {
      native = true;
      continue;
    }
    if (/^src\/features\/flockctl\//.test(path)) {
      frontend = true;
      native = true;
      continue;
    }
    if (
      /^(?:src\/|public\/|tests\/transcript-virtualization\/|index\.html$|package\.json$|pnpm-lock\.yaml$|(?:tsconfig|vite\.config|vitest\.config|postcss\.config|biome)[^/]*$)/.test(
        path,
      )
    ) {
      frontend = true;
      continue;
    }
    frontend = true;
    native = true;
  }
  return { frontend, native };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const base = event.pull_request?.base?.sha ?? event.before;
  const head = process.env.GITHUB_SHA;
  let scope = { frontend: true, native: true };
  if (
    /^[a-f0-9]{40}$/.test(base ?? "") &&
    !/^0+$/.test(base) &&
    /^[a-f0-9]{40}$/.test(head ?? "")
  ) {
    // --no-renames includes both sides of moves, including a removed native file.
    const paths = execFileSync(
      "git",
      ["diff", "--name-only", "--no-renames", "-z", base, head],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean);
    scope = scopeForPaths(paths);
  }
  const output = Object.entries(scope)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
