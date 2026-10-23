import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const script = resolve(import.meta.dirname, "../secret-scan.mjs");
const temporary = [];
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
async function repository() {
  const cwd = await mkdtemp(join(tmpdir(), "flock-secret-fixture-"));
  temporary.push(cwd);
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Example Developer");
  git(cwd, "config", "user.email", "developer@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  git(cwd, "commit", "--quiet", "--allow-empty", "-m", "Initial fixture");
  return cwd;
}
function scan(cwd, mode, input) {
  const result = spawnSync(process.execPath, [script, mode], {
    cwd,
    env,
    input,
    encoding: "utf8",
    timeout: 150_000,
  });
  assert.ifError(result.error);
  return result;
}
// Random, unissued values assembled at runtime, never actual credentials.
const fakeToken = () => ["ghp", randomBytes(18).toString("hex")].join("_");
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("secret publication guard", () => {
  it("allows clean history and pending source", async () => {
    const cwd = await repository();
    await writeFile(join(cwd, "source.txt"), "ordinary source\n");
    git(cwd, "add", "source.txt");
    assert.equal(scan(cwd, "check").status, 0);
  });
  it("rejects a staged credential even when the working file was cleaned", async () => {
    const cwd = await repository();
    const token = fakeToken();
    await writeFile(join(cwd, "source.txt"), `${token}\n`);
    git(cwd, "add", "source.txt");
    await writeFile(join(cwd, "source.txt"), "clean working copy\n");
    const result = scan(cwd, "staged");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Secret detected: source\.txt/);
    assert.ok(!(result.stdout + result.stderr).includes(token));
  });
  it("rejects outgoing history even if the credential was later removed", async () => {
    const cwd = await repository();
    const token = fakeToken();
    await writeFile(join(cwd, "source.txt"), `${token}\n`);
    git(cwd, "add", "source.txt");
    git(cwd, "commit", "--quiet", "-m", "Invented leaked fixture");
    await writeFile(join(cwd, "source.txt"), "clean tip\n");
    git(cwd, "commit", "--quiet", "-am", "Remove invented fixture");
    const sha = git(cwd, "rev-parse", "HEAD");
    const result = scan(
      cwd,
      "push",
      `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Secret detected/);
    assert.ok(!(result.stdout + result.stderr).includes(token));
  });
  it("fails closed on malformed ref input and non-repositories", async () => {
    const cwd = await repository();
    assert.notEqual(scan(cwd, "push", "bad-ref-input\n").status, 0);
    const outside = await mkdtemp(join(tmpdir(), "flock-secret-no-git-"));
    temporary.push(outside);
    assert.notEqual(scan(outside, "history").status, 0);
  });
});
