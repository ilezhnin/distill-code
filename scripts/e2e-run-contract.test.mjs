import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const producer = path.join(repoRoot, "scripts", "e2e-run-contract.mjs");
const token = "0123456789abcdef0123456789abcdef";

function run(...args) {
  return JSON.parse(
    execFileSync(process.execPath, [producer, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
}

test("produces an isolated cross-platform contract and Tauri overlay", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "berd-e2e-contract-"));
  const runRoot = path.join(base, "run-123");
  const contract = run("--run-root", runRoot, "--driver-token", token);

  assert.equal(contract.BERD_E2E_MODE, "1");
  assert.equal(contract.BERD_E2E_RUN_ROOT, runRoot);
  assert.equal(contract.BERD_E2E_RUN_ID, "run-123");
  assert.equal(contract.APP_TEST_DRIVER_TOKEN, token);
  assert.equal(
    contract.APP_TEST_DRIVER_READY_FILE,
    path.join(runRoot, "app-test-driver.json"),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(contract.TAURI_E2E_CONFIG, "utf8")),
    {
      identifier: "xyz.block.berd.e2e.run-123",
      productName: "Berd E2E (run-123)",
    },
  );
});

test("rejects Apple-unsafe and root-mismatched run IDs", () => {
  const base = mkdtempSync(path.join(os.tmpdir(), "berd-e2e-contract-"));
  for (const args of [
    ["--run-root", path.join(base, "run_123"), "--driver-token", token],
    [
      "--run-root",
      path.join(base, "run-123"),
      "--run-id",
      "other",
      "--driver-token",
      token,
    ],
    [
      "--run-root",
      path.join(base, "run-123"),
      "--driver-token",
      token,
      "--runtime-config",
      "relative.json",
    ],
  ]) {
    const result = spawnSync(process.execPath, [producer, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
  }
});
