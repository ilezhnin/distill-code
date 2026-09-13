import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
const script = join(repo, "scripts/hooks/no-ai-attribution.sh");
const tempDirs = [];

async function messageFile(content) {
  const dir = await mkdtemp(join(tmpdir(), "no-ai-attribution-test-"));
  tempDirs.push(dir);
  const path = join(dir, "COMMIT_EDITMSG");
  await writeFile(path, content);
  return path;
}

/** Run the hook against a commit-message file, as lefthook's commit-msg does. */
function runOnFile(content) {
  return messageFile(content).then((path) =>
    spawnSync("sh", [script, path], { cwd: repo, encoding: "utf8" }),
  );
}

/** Run the hook in CI's mode: a range of messages piped in on stdin. */
function runOnStdin(content) {
  return spawnSync("sh", [script, "-"], {
    cwd: repo,
    encoding: "utf8",
    input: content,
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("no-ai-attribution.sh", () => {
  it("passes a plain commit message", async () => {
    const result = await runOnFile("fix the thing that was broken\n");
    assert.equal(result.status, 0);
  });

  it("passes a legitimate Signed-off-by trailer", async () => {
    const result = await runOnFile(
      "fix the thing\n\nSigned-off-by: Ivan Lezhnin <ilezhnin@gmail.com>\n",
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects a Co-authored-by trailer", async () => {
    const result = await runOnFile(
      "fix the thing\n\nCo-authored-by: Claude <noreply@anthropic.com>\n",
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AI attribution is not allowed/);
  });

  it("rejects a Claude-Session footer", async () => {
    const result = await runOnFile(
      "fix the thing\n\nClaude-Session: https://claude.ai/code/session_1\n",
    );
    assert.equal(result.status, 1);
  });

  it("rejects a Generated with ... footer", async () => {
    const result = await runOnFile(
      "fix the thing\n\nGenerated with Claude Code\n",
    );
    assert.equal(result.status, 1);
  });

  it("rejects a body sentence claiming the work was made with an AI", async () => {
    const result = await runOnFile("fix the thing\n\nMade with Claude.\n");
    assert.equal(result.status, 1);
  });

  it("rejects an Assisted-by trailer naming an AI", async () => {
    const result = await runOnFile("fix the thing\n\nAssisted-by: Claude\n");
    assert.equal(result.status, 1, result.stderr);
  });

  it("rejects a Reviewed-by trailer naming an AI", async () => {
    const result = await runOnFile("fix the thing\n\nReviewed-by: Copilot\n");
    assert.equal(result.status, 1, result.stderr);
  });

  it("rejects a Helped-by trailer naming an AI", async () => {
    const result = await runOnFile("fix the thing\n\nHelped-by: ChatGPT\n");
    assert.equal(result.status, 1, result.stderr);
  });

  it("does not flag an unrelated -by trailer with no AI name", async () => {
    const result = await runOnFile(
      "fix the thing\n\nRequested-by: a teammate\n",
    );
    assert.equal(result.status, 0, result.stderr);
  });

  it("rejects a bare noreply@anthropic mention", async () => {
    const result = await runOnFile(
      "fix the thing\n\ncc noreply@anthropic.com\n",
    );
    assert.equal(result.status, 1);
  });

  it("ignores comment lines the way git leaves them in the editor buffer", async () => {
    const result = await runOnFile(
      "fix the thing\n\n# Generated with Claude Code\n",
    );
    assert.equal(result.status, 0, result.stderr);
  });

  describe("stdin mode (CI: a range of historical messages)", () => {
    it("passes a range of clean messages", () => {
      const result = runOnStdin("fix the thing\n\x00fix another thing\n");
      assert.equal(result.status, 0, result.stderr);
    });

    it("fails when any message in the range carries AI attribution", () => {
      const result = runOnStdin(
        [
          "fix the thing",
          "",
          "add a feature",
          "",
          "Co-authored-by: Claude <noreply@anthropic.com>",
          "",
        ].join("\n"),
      );
      assert.equal(result.status, 1);
    });

    it("does not require a git identity to be configured", () => {
      // Distinguishes this mode from the commit-msg path: scanning history
      // must not depend on (or fail because of) the environment's git
      // identity, which describes the invoking machine, not the commits
      // being scanned.
      const result = spawnSync("sh", [script, "-"], {
        cwd: repo,
        encoding: "utf8",
        input: "fix the thing\n",
        env: { PATH: process.env.PATH, HOME: "/nonexistent" },
      });
      assert.equal(result.status, 0, result.stderr);
    });
  });
});
