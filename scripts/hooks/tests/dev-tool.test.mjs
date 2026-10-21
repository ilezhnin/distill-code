import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

const repo = resolve(import.meta.dirname, "../../..");
const launcher = join(repo, "scripts/hooks/dev-tool.sh");
// The launcher itself needs a shell and the handful of utilities it calls; the
// point of every case below is what is *not* on PATH.
const BASE_PATH = "/usr/bin:/bin";
const tempDirs = [];

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "distill-dev-tool-test-"));
  tempDirs.push(path);
  return path;
}

/** A stand-in tool that reports how it was called. */
async function writeFakeTool(directory, name, { exitCode = 0 } = {}) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(
    path,
    [
      "#!/bin/sh",
      'echo "ran=$0"',
      'for arg in "$@"; do echo "arg=$arg"; done',
      'echo "path1=$(echo "$PATH" | cut -d: -f1)"',
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  await chmod(path, 0o755);
  return path;
}

function runLauncher(args, env = {}) {
  return spawnSync("sh", [launcher, ...args], {
    cwd: repo,
    encoding: "utf8",
    // A deliberately bare environment: inheriting the runner's would put the
    // real pnpm back on PATH and make every "missing tool" case vacuous.
    env: { PATH: BASE_PATH, HOME: "/nonexistent", ...env },
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// The launcher under test is the POSIX one; Windows hooks go through
// dev-tool.cmd, which these cases do not cover.
describe("dev-tool.sh", { skip: process.platform === "win32" }, () => {
  it("runs a tool found on PATH and forwards its arguments verbatim", async () => {
    const bin = await tempDir();
    await writeFakeTool(bin, "pnpm");

    const result = runLauncher(
      ["pnpm", "design-system:coverage", "--", "--strict"],
      { PATH: `${bin}:${BASE_PATH}` },
    );

    assert.equal(result.status, 0);
    // `--` must survive: a launcher that eats it silently changes which flags
    // reach the script behind `pnpm run`.
    assert.ok(result.stdout.includes("arg=design-system:coverage"));
    assert.ok(result.stdout.includes("arg=--"));
    assert.ok(result.stdout.includes("arg=--strict"));
  });

  it("finds a tool in an fnm per-shell directory and leads PATH with it", async () => {
    const home = await tempDir();
    const shell = join(home, "fnm_multishells", "4242_1700000000000");
    await writeFakeTool(shell, "pnpm");

    const result = runLauncher(["pnpm", "lint"], { LOCALAPPDATA: home });

    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes(join(shell, "pnpm")));
    // The shim calls the node next to it, so its own directory has to lead.
    assert.ok(result.stdout.includes(`path1=${shell}`));
  });

  it("blocks a missing tool on a developer machine too", () => {
    const result = runLauncher(["distill-missing-test-tool", "lint"]);

    assert.equal(result.status, 127);
    assert.ok(
      result.stderr.includes("distill-missing-test-tool was not found"),
    );
    assert.ok(result.stderr.includes("Refusing to skip"));
    assert.equal(result.stdout, "");
  });

  it("still fails hard on a missing tool where the environment is built, not chosen", () => {
    for (const env of [{ CI: "true" }, { DISTILL_REQUIRE_DEV_TOOLS: "1" }]) {
      const result = runLauncher(["distill-missing-test-tool", "fmt"], env);

      assert.equal(result.status, 127);
      assert.ok(
        result.stderr.includes("distill-missing-test-tool was not found"),
      );
      assert.ok(result.stderr.includes("Refusing to skip"));
    }
  });

  it("propagates the tool's own exit code, so a real check still blocks", async () => {
    const bin = await tempDir();
    await writeFakeTool(bin, "pnpm", { exitCode: 3 });

    const result = runLauncher(["pnpm", "lint"], {
      PATH: `${bin}:${BASE_PATH}`,
    });

    assert.equal(result.status, 3);
  });
});

describe("dev-tool.cmd", { skip: process.platform !== "win32" }, () => {
  it("forwards arguments and propagates the tool failure", async () => {
    const bin = join(await tempDir(), "bin with spaces");
    await mkdir(bin);
    await writeFile(
      join(bin, "distill-test-tool.cmd"),
      "@echo off\r\necho args=%*\r\nexit /b 23\r\n",
    );
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => name.toLowerCase() !== "path",
      ),
    );
    env.PATH = `${bin};${process.env.PATH}`;
    const result = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      [
        "/d",
        "/c",
        "scripts\\hooks\\dev-tool.cmd distill-test-tool lint -- --strict",
      ],
      { cwd: repo, encoding: "utf8", env },
    );
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stdout, /args=lint -- --strict/);
  });

  it("blocks a missing tool without requiring a CI environment", () => {
    const result = spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/c", "scripts\\hooks\\dev-tool.cmd distill-missing-test-tool"],
      { cwd: repo, encoding: "utf8", env: { ...process.env, CI: "" } },
    );
    assert.equal(result.status, 127, result.stderr);
    assert.match(result.stderr, /Refusing to skip/);
  });
});
