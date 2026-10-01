import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const worker = resolve("src-tauri/resources/benchmark-browser-worker.mjs");
const modulePath = require.resolve("playwright-core");
const browser =
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const evidence = resolve("../benchmark-qa/browser");
await mkdir(evidence, { recursive: true });

async function evaluate(kind, output, spec, image) {
  const child = spawn(process.execPath, [worker, modulePath, browser], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let text = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  child.stdin.end(
    JSON.stringify({
      kind,
      output,
      spec,
      screenshotPath: image
        ? join(evidence, `${image}-${Date.now()}.png`)
        : null,
    }),
  );
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(code, 0, `${text}\n${errors}`);
  return JSON.parse(text);
}

test("protected function assertions distinguish correct and incorrect repairs", async () => {
  const spec = JSON.parse(
    await readFile(
      "src-tauri/resources/benchmarks/range-sum-checks.json",
      "utf8",
    ),
  );
  assert.equal(
    (
      await evaluate(
        "javascript",
        "function sumRange(a,b){let s=0;for(let i=a;i<=b;i++)s+=i;return s;}",
        spec,
      )
    ).pass,
    true,
  );
  assert.equal(
    (await evaluate("javascript", "function sumRange(a,b){return 0;}", spec))
      .pass,
    false,
  );
});

test("candidate cannot access evaluator, filesystem, IPC or network", async () => {
  const source =
    "async function probe(){let net;try{await fetch('http://127.0.0.1:9999/');net=true;}catch{net=false;}return [typeof process,typeof require,typeof __TAURI_INTERNALS__,typeof test,net];}";
  const result = await evaluate("javascript", source, {
    functionName: "probe",
    argsCases: [
      {
        args: [],
        expected: ["undefined", "undefined", "undefined", "undefined", false],
      },
    ],
  });
  assert.equal(result.pass, true);
  assert.equal(result.boundary.network, false);
});

test("actual form interactions and independent screenshots", async () => {
  const spec = JSON.parse(
    await readFile(
      "src-tauri/resources/benchmarks/greeting-form-checks.json",
      "utf8",
    ),
  );
  const form =
    '<!doctype html><label for="name">Name</label><input id="name"><button id="submit" type="button">Greet</button><output id="result"></output>';
  const correct =
    form +
    '<script>document.querySelector("#submit").onclick=()=>{document.querySelector("#result").textContent="Hello, "+document.querySelector("#name").value+"!";};</script>';
  assert.equal(
    (await evaluate("browser", correct, spec, "passing-form")).pass,
    true,
  );
  assert.equal(
    (await evaluate("browser", form, spec, "failing-form")).pass,
    false,
  );
});
