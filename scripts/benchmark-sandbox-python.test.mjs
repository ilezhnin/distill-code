// The sandbox helpers' Python tests run on every platform without WSL, so
// they belong to the repository script tests rather than to a hand-run list.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const python = process.platform === "win32" ? "python" : "python3";

// The interpreter the runner provides changes under us (10-19: CI's new
// Python dropped `load_module`), so every run names it.
const version = spawnSync(python, ["--version"], { encoding: "utf8" });
const named = `${version.stdout ?? ""}${version.stderr ?? ""}`.trim();

// Each of these runs on Windows and on Linux alike: they replace the Linux
// boundary they need (flock, cgroup files, root ownership) with fixtures.
const suites = [
  "benchmark-browser-broker.test.py",
  "benchmark-linux-text-attestation.test.py",
  "benchmark-sandbox-budget.test.py",
  "benchmark-sandbox-digest.test.py",
  "benchmark-sandbox-snapshot-cache.test.py",
];

// A suite this list does not name is run by nothing.
test("every Python suite in scripts/ is listed here", () => {
  const present = readdirSync(resolve(root, "scripts"))
    .filter((name) => name.endsWith(".test.py"))
    .sort();
  assert.deepEqual(present, [...suites].sort());
});

for (const file of suites) {
  test(`scripts/${file}`, (t) => {
    t.diagnostic(named || `${python} --version failed`);
    const result = spawnSync(
      python,
      ["-I", resolve(root, "scripts", file), "-v"],
      { cwd: root, encoding: "utf8", timeout: 300_000 },
    );
    assert.equal(result.error, undefined, String(result.error));
    const output = `${named}\n${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    // unittest's own count, so a suite that collected nothing is not a pass,
    // and every case it skipped on this platform with the reason it gave.
    const lines = result.stderr.split(/\r?\n/);
    const ran = lines.find((line) => /^Ran \d+ tests? in /.test(line));
    assert.match(ran ?? "", /^Ran [1-9]\d* tests? in /, output);
    t.diagnostic(`${ran}: ${lines.findLast((line) => /^OK\b/.test(line))}`);
    for (const line of lines.filter((line) => / \.\.\. skipped /.test(line))) {
      t.diagnostic(`${process.platform}: ${line.trim()}`);
    }
  });
}
