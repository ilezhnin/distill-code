import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
const script = join(repo, "scripts/hooks/private-history-guard.sh");
const zero = "0".repeat(40);
const tempDirs = [];

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/**
 * An invented repository: `published` is the remote tip, `next` grows from
 * it, and `older` is unrelated history merged into `merged`.
 */
async function repository(value) {
  const dir = await mkdtemp(join(tmpdir(), "private-history-guard-test-"));
  tempDirs.push(dir);
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "config", "user.name", "Invented Operator");
  git(dir, "config", "user.email", "operator@example.invalid");
  if (value !== undefined)
    git(dir, "config", "distill.privateBenchmarkHistoryPending", value);
  const commit = (message) => {
    git(dir, "commit", "--quiet", "--allow-empty", "-m", message);
    return git(dir, "rev-parse", "HEAD");
  };
  const published = commit("published");
  const next = commit("next");
  git(dir, "checkout", "--quiet", "--orphan", "older");
  const older = commit("older");
  git(dir, "checkout", "--quiet", "main");
  git(
    dir,
    "merge",
    "--quiet",
    "--allow-unrelated-histories",
    "-m",
    "merged",
    "older",
  );
  const merged = git(dir, "rev-parse", "HEAD");
  return { dir, published, next, older, merged };
}

function push(dir, lines = []) {
  return spawnSync("sh", [script], {
    cwd: dir,
    encoding: "utf8",
    input: lines.map((line) => `${line}\n`).join(""),
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("private-history-guard", () => {
  it("allows any push when no remediation is pending", async () => {
    for (const value of [undefined, "false"]) {
      const { dir, older } = await repository(value);
      assert.equal(
        push(dir, [`refs/tags/old ${older} refs/tags/old ${zero}`]).status,
        0,
      );
    }
  });

  it("publishes a fast-forward of an existing branch while pending", async () => {
    const { dir, published, next } = await repository("true");
    const result = push(dir, [
      `refs/heads/main ${next} refs/heads/main ${published}`,
    ]);
    assert.equal(result.status, 0, result.stderr);
  });

  it("refuses tags, new or deleted refs and merged older history while pending", async () => {
    const { dir, published, next, older, merged } = await repository("true");
    for (const line of [
      `refs/tags/old ${older} refs/tags/old ${zero}`,
      `refs/heads/older ${older} refs/heads/older ${zero}`,
      `(delete) ${zero} refs/heads/main ${published}`,
      `refs/heads/main ${merged} refs/heads/main ${published}`,
      `refs/heads/main ${published} refs/heads/main ${next}`,
    ]) {
      const result = push(dir, [line]);
      assert.equal(result.status, 1, line);
      assert.match(result.stderr, /Push refused/);
    }
  });

  it("refuses when the setting is not a readable boolean", async () => {
    const { dir, published, next } = await repository("maybe");
    assert.equal(
      push(dir, [`refs/heads/main ${next} refs/heads/main ${published}`])
        .status,
      1,
    );
  });
});
