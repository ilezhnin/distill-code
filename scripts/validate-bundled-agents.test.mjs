/**
 * The bundled-agent gate, checked negatively.
 *
 * `just check` runs this validator over `distro/agents/*.md`, so the gate is
 * only worth as much as the validator — and nothing exercised the validator
 * against a bad manifest. A gate that passes everything is indistinguishable
 * from no gate, and the failure it is meant to catch (an agent that ships
 * without the frontmatter the runtime seeder needs) is only visible at runtime,
 * in a built installer.
 *
 * The validator is a `.ts` script run through `tsx`, so these cases drive the
 * real CLI the way `just check` does — exit status included — rather than
 * importing it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
// tsx's own entry point, run by this node: `node_modules/.bin/tsx` is a shell
// script (and `tsx.cmd` a batch file) on Windows, which `execFileSync` cannot
// start without a shell — every case here failed to spawn, status `null`.
const TSX_CLI = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const VALIDATOR = path.join(HERE, "validate-bundled-agents.ts");

/** Everything a bundled agent must carry, as the shipped ones do. */
const VALID_FRONTMATTER = {
  name: "Probe",
  description: "A manifest written by the validator's own tests.",
  good_for: "checking the gate",
  vibes: "brisk",
  avatar: "app-avatar:probe",
};

function manifest(overrides = {}, omit = []) {
  const fields = { ...VALID_FRONTMATTER, ...overrides };
  for (const key of omit) delete fields[key];
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return `---\n${lines.join("\n")}\nmetadata:\n  distillBundled: true\n---\n\nBody.\n`;
}

/** Runs the validator over one file; returns its exit status and stderr. */
function validate(filePath) {
  try {
    execFileSync(process.execPath, [TSX_CLI, VALIDATOR, filePath], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    return { status: error.status, stderr: String(error.stderr ?? "") };
  }
}

describe("the bundled agent validator catches a bad manifest", () => {
  let dir;

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bundled-agents-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(name, contents) {
    const filePath = path.join(dir, name);
    writeFileSync(filePath, contents, "utf8");
    return filePath;
  }

  it("accepts a manifest that carries the whole contract", () => {
    const result = validate(write("good.md", manifest()));
    assert.equal(result.status, 0, result.stderr);
  });

  it("fails on a missing required field", () => {
    const result = validate(
      write("no-description.md", manifest({}, ["description"])),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /`description` is required/);
  });

  it("fails on a manifest with no frontmatter at all", () => {
    const result = validate(write("bare.md", "Just a body.\n"));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /YAML frontmatter block/);
  });

  it("fails when the agent is not marked as bundled", () => {
    const result = validate(
      write(
        "not-bundled.md",
        `---\n${Object.entries(VALID_FRONTMATTER)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n")}\n---\n\nBody.\n`,
      ),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /distillBundled/);
  });

  it("fails on an avatar ref that names no image", () => {
    const result = validate(
      write("bad-avatar.md", manifest({ avatar: "agent-avatar:missing" })),
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /`avatar` is required/);
  });

  it("passes over every shipped manifest with no arguments", () => {
    // The form `just check` uses: no paths, so it resolves `distro/agents/*.md`
    // relative to the script rather than to the working directory.
    try {
      execFileSync(process.execPath, [TSX_CLI, VALIDATOR], {
        cwd: tmpdir(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      assert.fail(`the shipped manifests do not validate: ${error.stderr}`);
    }
  });
});
