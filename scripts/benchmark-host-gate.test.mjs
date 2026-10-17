// Every producer of the Windows host gate (`DISTILL_BENCH_HOST_GATE`) and
// every check of it must agree on the number of fields. The operator scripts
// sample the gate in PowerShell and validate their own sample before sending
// it; a field added on one side once made selftest and every probe refuse
// their own sample. This reads each script's emitter, renders it with digits
// and runs the script's own validation pattern on it, and compares the field
// count with the app (Rust), bench-run and bench-budget.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

/** The gate one script's PowerShell emitter writes, every value a digit. */
function emitted(source) {
  const lines = source
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Write-Output"));
  assert.equal(lines.length, 1, "one gate emitter per script");
  const [line] = lines;
  const joined = line.match(/Join\(',',@\((.*)\)\)\)$/u);
  if (joined) {
    // Split the array at its top-level commas only.
    let depth = 0;
    let fields = 1;
    for (const char of joined[1]) {
      if (char === "(" || char === "[") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (char === "," && depth === 0) fields++;
    }
    return Array(fields).fill("1").join(",");
  }
  const quoted = line.match(/^Write-Output "(.*)"$/u);
  assert.ok(quoted, `unrecognized gate emitter: ${line}`);
  return quoted[1]
    .replace(/\$\((?:[^()]|\([^()]*\))*\)/gu, "1")
    .replace(/\$[A-Za-z_.]+/gu, "1");
}

/** The script's own patterns for a gate: regex literals of digit fields. */
function validators(source) {
  const found = [...source.matchAll(/\/\^((?:\\d\+,)+\\d\+)\$\/u?/gu)].map(
    (match) => new RegExp(`^${match[1]}$`, "u"),
  );
  assert.ok(found.length > 0, "the script validates its gate");
  return found;
}

const fields = (gate) => gate.split(",").length;

const SCRIPTS = [
  "scripts/benchmark-sandbox-selftest.mjs",
  "scripts/benchmark-browser-ready.mjs",
  "scripts/benchmark-linux-text-policy-probe.mjs",
  "scripts/benchmark-browser-worker.test.mjs",
];

test("every operator script accepts the gate its own emitter writes", () => {
  for (const script of SCRIPTS) {
    const source = read(script);
    const gate = emitted(source);
    for (const pattern of validators(source))
      assert.match(gate, pattern, `${script} refuses its own gate ${gate}`);
  }
});

test("the app, bench-run and bench-budget expect the same number of fields", () => {
  const rust = read("src-tauri/src/services/benchmark_sandbox.rs").match(
    /"\{now\}((?:,\{\})+)"/u,
  );
  assert.ok(rust, "the app formats its gate");
  // {now} and one {} per further field.
  const expected = 1 + rust[1].match(/\{\}/gu).length;
  const run = read("src-tauri/resources/benchmark-sandbox/bench-run").match(
    /DISTILL_BENCH_HOST_GATE=\*[^\n]*\n\s*\[\[ \$\{1#\*=\} =~ \^((?:\[0-9\]\+,)+\[0-9\]\+)\$/u,
  );
  assert.ok(run, "bench-run checks the gate's shape");
  assert.equal(run[1].split(",").length, expected, "bench-run");
  const budget = read(
    "src-tauri/resources/benchmark-sandbox/bench-budget",
  ).match(/^\s*((?:\w+, )+\w+) = map\(int, gate\.split\(','\)\)/mu);
  assert.ok(budget, "bench-budget unpacks the gate");
  assert.equal(budget[1].split(", ").length, expected, "bench-budget");
  for (const script of SCRIPTS)
    assert.equal(fields(emitted(read(script))), expected, script);
});
