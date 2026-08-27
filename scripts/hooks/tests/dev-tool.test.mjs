import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../../..");
const launcher = join(repo, "scripts/hooks/dev-tool.sh");
// The launcher itself needs a shell and the handful of utilities it calls; the
// point of every case below is what is *not* on PATH.
const BASE_PATH = "/usr/bin:/bin";
const tempDirs = [];

async function tempDir() {
  const path = await mkdtemp(join(tmpdir(), "berd-dev-tool-test-"));
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

describe("dev-tool.sh", () => {
  it("runs a tool found on PATH and forwards its arguments verbatim", async () => {
    const bin = await tempDir();
    await writeFakeTool(bin, "pnpm");

    const result = runLauncher(
      ["pnpm", "design-system:coverage", "--", "--strict"],
      { PATH: `${bin}:${BASE_PATH}` },
    );

    expect(result.status).toBe(0);
    // `--` must survive: a launcher that eats it silently changes which flags
    // reach the script behind `pnpm run`.
    expect(result.stdout).toContain("arg=design-system:coverage");
    expect(result.stdout).toContain("arg=--");
    expect(result.stdout).toContain("arg=--strict");
  });

  it("finds a tool in an fnm per-shell directory and leads PATH with it", async () => {
    const home = await tempDir();
    const shell = join(home, "fnm_multishells", "4242_1700000000000");
    await writeFakeTool(shell, "pnpm");

    const result = runLauncher(["pnpm", "lint"], { LOCALAPPDATA: home });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(shell, "pnpm"));
    // The shim calls the node next to it, so its own directory has to lead.
    expect(result.stdout).toContain(`path1=${shell}`);
  });

  it("warns and lets the push through when the tool is genuinely missing", () => {
    const result = runLauncher(["pnpm", "lint"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("pnpm was not found");
    expect(result.stderr).toContain("Skipping the check");
    expect(result.stdout).toBe("");
  });

  it("still fails hard on a missing tool where the environment is built, not chosen", () => {
    for (const env of [{ CI: "true" }, { BERD_REQUIRE_DEV_TOOLS: "1" }]) {
      const result = runLauncher(["cargo", "fmt"], env);

      expect(result.status).toBe(127);
      expect(result.stderr).toContain("cargo was not found");
      expect(result.stderr).toContain("Refusing to skip");
    }
  });

  it("propagates the tool's own exit code, so a real check still blocks", async () => {
    const bin = await tempDir();
    await writeFakeTool(bin, "pnpm", { exitCode: 3 });

    const result = runLauncher(["pnpm", "lint"], {
      PATH: `${bin}:${BASE_PATH}`,
    });

    expect(result.status).toBe(3);
  });
});
