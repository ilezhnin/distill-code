import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
const script = join(repo, "scripts/hooks/private-history-guard.sh");
const tempDirs = [];

/** An invented repository whose only setting is the guard value given. */
async function repository(value) {
  const dir = await mkdtemp(join(tmpdir(), "private-history-guard-test-"));
  tempDirs.push(dir);
  spawnSync("git", ["init", "--quiet", dir]);
  if (value !== undefined)
    spawnSync("git", [
      "-C",
      dir,
      "config",
      "distill.privateBenchmarkHistoryPending",
      value,
    ]);
  return dir;
}

function push(dir) {
  return spawnSync("sh", [script], { cwd: dir, encoding: "utf8" });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("private-history-guard", () => {
  it("allows a push when no remediation is pending", async () => {
    assert.equal(push(await repository()).status, 0);
    assert.equal(push(await repository("false")).status, 0);
  });

  it("refuses a push while remediation is pending", async () => {
    const result = push(await repository("true"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Push refused/);
  });

  it("refuses when the setting is not a readable boolean", async () => {
    assert.equal(push(await repository("maybe")).status, 1);
  });
});
