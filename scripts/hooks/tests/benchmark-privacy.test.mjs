import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const script = resolve(import.meta.dirname, "../benchmark-privacy.mjs");
const temporary = [];
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
async function repository(file, content) {
  const cwd = await mkdtemp(join(tmpdir(), "flock-privacy-fixture-"));
  temporary.push(cwd);
  git(cwd, "init", "--quiet");
  git(cwd, "config", "user.name", "Example Developer");
  git(cwd, "config", "user.email", "developer@example.invalid");
  git(cwd, "config", "commit.gpgsign", "false");
  await mkdir(dirname(join(cwd, file)), { recursive: true });
  await writeFile(join(cwd, file), content);
  git(cwd, "add", file);
  return cwd;
}
function scan(cwd, mode) {
  return spawnSync(process.execPath, [script, mode], {
    cwd,
    env,
    encoding: "utf8",
  });
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("private material publication guard", () => {
  it("allows ordinary docs and an environment template", async () => {
    for (const file of [
      "docs/guide.md",
      ".env.example",
      "src/shared/i18n/locales/en/memory.json",
    ]) {
      const cwd = await repository(file, "Example placeholder\n");
      assert.equal(scan(cwd, "--staged").status, 0);
      git(cwd, "commit", "--quiet", "-m", "Public fixture");
      assert.equal(scan(cwd, "--tree").status, 0);
    }
  });
  it("handles binary assets larger than the old per-file Git buffer", async () => {
    const cwd = await repository("font.woff2", Buffer.alloc(2 * 1024 * 1024));
    assert.equal(scan(cwd, "--staged").status, 0);
    git(cwd, "commit", "--quiet", "-m", "Invented binary asset");
    assert.equal(scan(cwd, "--tree").status, 0);
  });
  it("rejects private paths before commit and in a bypassed published tree", async () => {
    for (const file of [".env", "lore.md", "data.sqlite"]) {
      const cwd = await repository(file, "invented private content\n");
      assert.equal(scan(cwd, "--staged").status, 1);
      git(
        cwd,
        "commit",
        "--quiet",
        "-m",
        "Unsafe fixture without installed hooks",
      );
      assert.equal(scan(cwd, "--tree").status, 1);
    }
  });
  it("reports a private artifact reference without printing its contents", async () => {
    const reference = [
      "benchmark-review-qa",
      "invented-local-report.json",
    ].join("/");
    const cwd = await repository("docs/guide.md", reference);
    const result = scan(cwd, "--staged");
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(reference));
  });
});
