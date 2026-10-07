import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
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
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }, 20000);
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
    child.on("close", resolve);
  }).finally(() => clearTimeout(timeout));
  assert.equal(expired, false, "Worker did not finish within 20 seconds");
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
  assert.equal(
    (await evaluate("browser", correct.replace(/<label.*?<\/label>/, ""), spec))
      .pass,
    false,
  );
  assert.equal(
    (
      await evaluate(
        "browser",
        correct.replace(
          '<label for="name">Name</label><input id="name">',
          '<label>Project title<input id="name"></label>',
        ),
        spec,
      )
    ).pass,
    true,
  );
});

test("keyboard submission exercises Enter instead of substituting a click", async () => {
  const form =
    '<form><label>Name<input id="name"></label><button>Save</button><output id="result"></output></form><script>document.querySelector("form").onsubmit=e=>{e.preventDefault();document.querySelector("#result").textContent="Saved "+document.querySelector("#name").value;};</script>';
  const spec = {
    steps: [
      { action: "fill", selector: "#name", value: "Ada" },
      { action: "press", selector: "#name", value: "Enter" },
      { action: "expectText", selector: "#result", value: "Saved Ada" },
    ],
  };
  assert.equal((await evaluate("browser", form, spec)).pass, true);
  const broken =
    form +
    '<script>document.querySelector("#name").onkeydown=e=>{if(e.key==="Enter")e.preventDefault();};</script>';
  assert.equal((await evaluate("browser", broken, spec)).pass, false);
});

test("failed interaction completes even when Edge profile cleanup is denied", async () => {
  const result = await evaluate(
    "browser",
    '<form><label>Name<input id="name" required></label><button id="submit" disabled>Save</button><output id="result"></output></form>',
    {
      steps: [
        { action: "fill", selector: "#name", value: "Ada" },
        { action: "click", selector: "#submit" },
        { action: "expectText", selector: "#result", value: "Saved Ada" },
      ],
    },
  );
  assert.equal(result.pass, false);
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, false, false],
  );
  // Cleanup failures remain visible, but are not candidate failures or hangs.
  if (result.cleanupWarning) {
    assert.equal(typeof result.cleanupWarning.code, "string");
    assert.match(
      result.cleanupWarning.retainedProfile,
      /distill-benchmark-browser-/,
    );
  }
});

test("immutable input checks observe nested changes independently of a correct result", async () => {
  const spec = {
    functionName: "update",
    immutableArgs: [0],
    argsCases: [
      { args: [{ nested: { value: 1 } }], expected: { nested: { value: 2 } } },
    ],
  };
  for (const source of [
    "function update(input){return {nested:{value:input.nested.value+1}};}",
    "function update(input){const copy=structuredClone(input);copy.nested.value++;return copy;}",
  ])
    assert.equal((await evaluate("javascript", source, spec)).pass, true);
  const result = await evaluate(
    "javascript",
    "function update(input){input.nested.value++;return input;}",
    spec,
  );
  assert.equal(result.pass, false);
  assert.equal(result.checks[0].outputMatches, true);
  assert.equal(result.checks[0].inputsPreserved, false);
});
