// The snapshot cache's Python tests run on every platform without WSL, so
// they belong to the repository script tests rather than to a hand-run list.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const python = process.platform === "win32" ? "python" : "python3";

for (const file of ["scripts/benchmark-sandbox-snapshot-cache.test.py"]) {
  test(file, () => {
    const result = spawnSync(python, ["-I", resolve(root, file)], {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}
