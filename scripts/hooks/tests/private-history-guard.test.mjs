import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
 * An invented repository with a reviewed base, a later remote tip and both
 * unrelated history and a legacy branch that split before the reviewed base.
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
  const beforeReview = commit("before review");
  const base = commit("reviewed base");
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
  git(dir, "checkout", "--quiet", "-b", "topic", base);
  const topic = commit("topic change");
  git(dir, "checkout", "--quiet", "-b", "clean", next);
  git(dir, "merge", "--quiet", "-m", "merge topic", "topic");
  const cleanMerged = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "--quiet", "-b", "legacy", beforeReview);
  const legacy = commit("legacy change");
  git(dir, "checkout", "--quiet", "clean");
  git(dir, "merge", "--quiet", "-m", "merge legacy", "legacy");
  const legacyMerged = git(dir, "rev-parse", "HEAD");
  return {
    dir,
    base,
    published,
    next,
    older,
    merged,
    topic,
    cleanMerged,
    legacy,
    legacyMerged,
  };
}

function push(dir, lines = [], remoteUrl) {
  const result = spawnSync("sh", [script, ...(remoteUrl ? [remoteUrl] : [])], {
    cwd: dir,
    encoding: "utf8",
    input: lines.map((line) => `${line}\n`).join(""),
  });
  assert.ifError(result.error);
  return result;
}

function publishFixture(dir, tip, name = "remote") {
  const remote = join(dir, `${name}.git`);
  git(dir, "init", "--quiet", "--bare", remote);
  git(dir, "push", "--quiet", remote, `${tip}:refs/heads/main`);
  return remote;
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

  it("allows a topic merged from a reviewed base older than the remote tip", async () => {
    const { dir, base, published, cleanMerged } = await repository("true");
    const update = `refs/heads/main ${cleanMerged} refs/heads/main ${published}`;
    assert.equal(push(dir, [update]).status, 1);
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    const result = push(dir, [update]);
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects legacy side commits even when their merge descends from the reviewed base", async () => {
    const { dir, base, published, merged, legacyMerged } =
      await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    for (const tip of [merged, legacyMerged]) {
      const result = push(dir, [
        `refs/heads/main ${tip} refs/heads/main ${published}`,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /outside its reviewed published history/);
    }
  });

  it("requires the configured base to be an immutable available commit", async () => {
    const { dir, published, next } = await repository("true");
    for (const base of ["", "main", published.slice(0, 12), "f".repeat(40)]) {
      git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
      const result = push(dir, [
        `refs/heads/main ${next} refs/heads/main ${published}`,
      ]);
      assert.equal(result.status, 1, base);
      assert.match(result.stderr, /full commit ID/);
    }
  });

  it("rejects a base that was not published on the destination branch", async () => {
    const { dir, published, next, older } = await repository("true");
    for (const base of [next, older]) {
      git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
      const result = push(dir, [
        `refs/heads/main ${next} refs/heads/main ${published}`,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not contain the reviewed base/);
    }
  });

  it("still rejects tags, deletion and non-fast-forward updates with a reviewed base", async () => {
    const { dir, base, published, next } = await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    for (const update of [
      `refs/tags/new ${next} refs/tags/new ${zero}`,
      `(delete) ${zero} refs/heads/main ${published}`,
      `refs/heads/main ${published} refs/heads/main ${next}`,
    ]) {
      assert.equal(push(dir, [update]).status, 1);
    }
  });

  it("publishes a new topic from the reviewed base advertised by the actual remote", async () => {
    const { dir, base, published, topic } = await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    const remote = publishFixture(dir, published);
    const result = push(
      dir,
      [`refs/heads/topic ${topic} refs/heads/topic ${zero}`],
      remote,
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it("does not trust a stale tracking ref, another remote or an unavailable destination", async () => {
    const { dir, base, published, topic, older } = await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    git(dir, "update-ref", "refs/remotes/origin/main", published);
    const unrelatedRemote = publishFixture(dir, older);
    const emptyRemote = join(dir, "empty.git");
    git(dir, "init", "--quiet", "--bare", emptyRemote);
    for (const remote of [
      undefined,
      unrelatedRemote,
      emptyRemote,
      join(dir, "missing.git"),
    ]) {
      const result = push(
        dir,
        [`refs/heads/topic ${topic} refs/heads/topic ${zero}`],
        remote,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /cannot verify its reviewed base/);
    }
  });

  it("refuses new branches that contain legacy or unrelated history", async () => {
    const { dir, base, published, older, legacy, legacyMerged } =
      await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    const remote = publishFixture(dir, published);
    for (const tip of [older, legacy, legacyMerged]) {
      assert.equal(
        push(dir, [`refs/heads/topic ${tip} refs/heads/topic ${zero}`], remote)
          .status,
        1,
      );
    }
  });

  it("fails the whole push when one of several refs contains legacy history", async () => {
    const { dir, base, published, cleanMerged, legacyMerged } =
      await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    assert.equal(
      push(dir, [
        `refs/heads/unsafe ${legacyMerged} refs/heads/unsafe ${published}`,
        `refs/heads/main ${cleanMerged} refs/heads/main ${published}`,
      ]).status,
      1,
    );
  });

  it("refuses incomplete local history", async () => {
    const { dir, base, published, next } = await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    await writeFile(join(dir, ".git", "shallow"), `${base}\n`);
    const result = push(dir, [
      `refs/heads/main ${next} refs/heads/main ${published}`,
    ]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete local history/);
  });

  it("refuses when the advertised commit is unavailable locally", async () => {
    const { dir, base, next } = await repository("true");
    git(dir, "config", "distill.privateBenchmarkReviewedBase", base);
    const result = push(dir, [
      `refs/heads/main ${next} refs/heads/main ${"f".repeat(40)}`,
    ]);
    assert.equal(result.status, 1);
  });
});
