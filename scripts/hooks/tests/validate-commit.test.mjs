import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const hook = resolve(import.meta.dirname, "../validate-commit.sh").replaceAll(
  "\\",
  "/",
);
const temporary = [];
// Git exports repository-local variables into hooks. Fixture repositories must
// never inherit the real commit's index, worktree, object store, or config.
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

function git(dir, ...args) {
  const result = spawnSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    env: gitEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixture(command = "exit 0") {
  const root = await mkdtemp(join(tmpdir(), "distill-commit-gate-"));
  temporary.push(root);
  const repo = join(root, "repo with spaces");
  const bin = join(root, "bin");
  const hooks = join(root, "hooks");
  await Promise.all([repo, bin, hooks].map((dir) => mkdir(dir)));
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Example Developer");
  git(repo, "config", "user.email", "developer@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "source.txt"), "initial\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "--quiet", "-m", "Initial fixture");
  await writeFile(join(repo, "source.txt"), "staged\n");
  git(repo, "add", "source.txt");
  const before = git(repo, "rev-parse", "HEAD");
  const script = join(bin, "just");
  await writeFile(
    script,
    `#!/bin/sh\n[ "$*" = "ci" ] || exit 99\n[ -z "\${GIT_INDEX_FILE+x}" ] || exit 98\necho gate-invoked\n${command}\n`,
  );
  await chmod(script, 0o755);
  // Exercise an actual git commit, not just the hook's return value.
  const entry = join(hooks, "pre-commit");
  const shellBin = bin
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  await writeFile(
    entry,
    `#!/bin/sh\nPATH='${shellBin}':"$PATH"\nexport PATH\nexec sh '${hook}'\n`,
  );
  await chmod(entry, 0o755);
  git(repo, "config", "core.hooksPath", hooks);
  return {
    repo,
    before,
    commit() {
      return spawnSync("git", ["commit", "-m", "Checked fixture"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...gitEnv, GIT_INDEX_FILE: join(repo, ".git/index") },
      });
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("commit validation gate", () => {
  it("allows a commit only after the complete gate succeeds", async () => {
    const test = await fixture();
    const result = test.commit();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout + result.stderr, /gate-invoked/);
    assert.notEqual(git(test.repo, "rev-parse", "HEAD"), test.before);
  });

  it("rejects a failed check and leaves HEAD unchanged", async () => {
    const test = await fixture("exit 23");
    const result = test.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /gate-invoked/);
    assert.equal(git(test.repo, "rev-parse", "HEAD"), test.before);
  });

  it("rejects a partially staged file before running checks", async () => {
    const test = await fixture();
    await writeFile(join(test.repo, "source.txt"), "unstaged fix\n");
    const result = test.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unstaged changes/);
    assert.doesNotMatch(result.stdout + result.stderr, /gate-invoked/);
    assert.equal(git(test.repo, "show", ":source.txt"), "staged");
    assert.equal(git(test.repo, "rev-parse", "HEAD"), test.before);
  });

  it("rejects untracked source absent from the commit", async () => {
    const test = await fixture();
    await writeFile(join(test.repo, "helper.txt"), "untracked\n");
    const result = test.commit();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /untracked files/);
    assert.equal(git(test.repo, "rev-parse", "HEAD"), test.before);
  });

  for (const stage of [false, true]) {
    it(`rejects changes during validation (staged: ${stage})`, async () => {
      const test = await fixture(
        `echo changed > source.txt\n${stage ? "git add source.txt" : ""}\nexit 0`,
      );
      const result = test.commit();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Commit blocked/);
      assert.equal(git(test.repo, "rev-parse", "HEAD"), test.before);
    });
  }
});
