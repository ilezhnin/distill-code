import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const hooks = {
  "pre-commit": resolve(import.meta.dirname, "../validate-commit.sh"),
  "pre-push": resolve(import.meta.dirname, "../validate-push.sh"),
};
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

function shellPath(path) {
  return path
    .replaceAll("\\", "/")
    .replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "distill-push-gate-"));
  temporary.push(root);
  const repo = join(root, "repo with spaces");
  const remote = join(root, "remote.git");
  const bin = join(root, "bin");
  const hookDir = join(root, "hooks");
  await Promise.all([repo, remote, bin, hookDir].map((dir) => mkdir(dir)));
  git(remote, "init", "--quiet", "--bare");
  git(repo, "init", "--quiet");
  git(repo, "config", "user.name", "Example Developer");
  git(repo, "config", "user.email", "developer@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "remote", "add", "origin", remote);
  await writeFile(join(repo, "source.txt"), "initial\n");
  git(repo, "add", "source.txt");
  git(repo, "commit", "--quiet", "-m", "Initial fixture");
  const script = join(bin, "just");
  await writeFile(
    script,
    '#!/bin/sh\n[ "$*" = "ci" ] || exit 99\necho gate-invoked\n',
  );
  await chmod(script, 0o755);
  // Exercise actual git commits and pushes, not just the hooks' return values.
  for (const [name, hook] of Object.entries(hooks)) {
    const entry = join(hookDir, name);
    await writeFile(
      entry,
      `#!/bin/sh\nPATH='${shellPath(bin)}':"$PATH"\nexport PATH\nexec sh '${hook.replaceAll("\\", "/")}'\n`,
    );
    await chmod(entry, 0o755);
  }
  git(repo, "config", "core.hooksPath", hookDir);
  const run = (args) =>
    spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv });
  return {
    repo,
    async change(text) {
      await writeFile(join(repo, "source.txt"), text);
      git(repo, "add", "source.txt");
    },
    commit: (...extra) => run(["commit", "-m", "Checked fixture", ...extra]),
    push: (...refs) => run(["push", "origin", ...refs]),
    output: (result) => result.stdout + result.stderr,
    record: () => readFile(join(repo, ".git/distill-validated-trees"), "utf8"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("push validation gate", () => {
  it("records the tree a commit validated and pushes it without a second gate", async () => {
    const test = await fixture();
    await test.change("checked\n");
    const commit = test.commit();
    assert.equal(commit.status, 0, commit.stderr);
    assert.match(test.output(commit), /gate-invoked/);
    assert.equal(
      (await test.record()).trim(),
      git(test.repo, "rev-parse", "HEAD^{tree}"),
    );
    const push = test.push("HEAD:refs/heads/main");
    assert.equal(push.status, 0, push.stderr);
    assert.doesNotMatch(test.output(push), /gate-invoked/);
    assert.match(test.output(push), /validated at commit/);
    assert.equal(
      git(test.repo, "ls-remote", "--heads", "origin", "main").split("\t")[0],
      git(test.repo, "rev-parse", "HEAD"),
    );
  });

  it("runs the gate for a pushed tree no commit hook validated", async () => {
    const test = await fixture();
    await test.change("unchecked\n");
    const commit = test.commit("--no-verify");
    assert.equal(commit.status, 0, commit.stderr);
    const push = test.push("HEAD:refs/heads/main");
    assert.equal(push.status, 0, push.stderr);
    assert.match(test.output(push), /gate-invoked/);
    assert.equal(
      (await test.record()).trim(),
      git(test.repo, "rev-parse", "HEAD^{tree}"),
    );
    const again = test.push("HEAD:refs/heads/again");
    assert.equal(again.status, 0, again.stderr);
    assert.doesNotMatch(test.output(again), /gate-invoked/);
  });

  it("refuses an unvalidated tree whose checkout has unstaged changes", async () => {
    const test = await fixture();
    await test.change("unchecked\n");
    assert.equal(test.commit("--no-verify").status, 0);
    await writeFile(join(test.repo, "source.txt"), "edited since\n");
    const push = test.push("HEAD:refs/heads/main");
    assert.notEqual(push.status, 0);
    assert.match(test.output(push), /Push blocked: unstaged changes/);
    assert.doesNotMatch(test.output(push), /gate-invoked/);
    assert.equal(git(test.repo, "ls-remote", "--heads", "origin"), "");
  });

  it("refuses an unvalidated tree that is not the checked-out one", async () => {
    const test = await fixture();
    git(test.repo, "switch", "--quiet", "-c", "topic");
    await test.change("topic\n");
    assert.equal(test.commit("--no-verify").status, 0);
    git(test.repo, "switch", "--quiet", "-");
    const push = test.push("topic:refs/heads/topic");
    assert.notEqual(push.status, 0);
    assert.match(test.output(push), /not the one being pushed/);
    assert.doesNotMatch(test.output(push), /gate-invoked/);
    assert.equal(git(test.repo, "ls-remote", "--heads", "origin"), "");
  });

  it("pushes a branch deletion without a gate", async () => {
    const test = await fixture();
    await test.change("checked\n");
    assert.equal(test.commit().status, 0);
    assert.equal(test.push("HEAD:refs/heads/old").status, 0);
    const deletion = test.push("--delete", "old");
    assert.equal(deletion.status, 0, deletion.stderr);
    assert.doesNotMatch(test.output(deletion), /gate-invoked/);
    assert.equal(git(test.repo, "ls-remote", "--heads", "origin", "old"), "");
  });
});
