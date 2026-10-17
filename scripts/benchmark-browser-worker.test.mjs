import assert from "node:assert/strict";
import { test as nodeTest } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";

// Live renderer regression tests require explicit opt-in and provisioned
// Linux pins. No test automatically installs software or launches Windows Edge.
const test = (name, run) =>
  nodeTest(
    name,
    { skip: process.env.DISTILL_BENCH_BROWSER_TESTS !== "1" },
    run,
  );
const evidence = resolve("../benchmark-qa/browser");
if (process.env.DISTILL_BENCH_BROWSER_TESTS === "1")
  await mkdir(evidence, { recursive: true });

const headroom = String.raw`
$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
$memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$distro=Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | Get-ItemProperty | Where-Object DistributionName -eq 'distill-bench'
if (@($distro).Count -ne 1) { throw 'Sandbox registration is missing or ambiguous' }
$basePath=$distro.BasePath
if ($basePath.StartsWith('\\?\')) { $basePath=$basePath.Substring(4) }
$volume=[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($basePath))
$ram=[uint64]$os.FreePhysicalMemory*1024
$commit=[uint64]$memory.CommitLimit-[uint64]$memory.CommittedBytes
$disk=[uint64]$volume.AvailableFreeSpace
# The fifth field is the host CPU share in thousandths; 1001 = not sampled.
Write-Output "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),$ram,$commit,$disk,1001"
`;

async function reserveBrowser(id) {
  assert.equal(
    process.platform,
    "win32",
    "Live broker tests require real Windows headroom",
  );
  const deadline = Date.now() + 440000;
  const waitUntil = Date.now() + 300000;
  while (Date.now() < waitUntil) {
    const sampled = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", headroom],
      { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096 },
    );
    assert.equal(sampled.status, 0, sampled.stderr);
    const gate = sampled.stdout.trim();
    assert.match(gate, /^\d+,\d+,\d+,\d+,\d+$/u);
    const reserved = spawnSync(
      "wsl.exe",
      [
        "-d",
        "distill-bench",
        "-u",
        "root",
        "--exec",
        "/usr/local/sbin/bench-budget",
        "reserve",
        "browser",
        id,
        String(deadline),
        gate,
        String(8 * 1024 * 1024 + 128 * 1024),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 4096 },
    );
    if (reserved.status === 0) {
      const value = JSON.parse(reserved.stdout);
      assert.equal(value.id, id);
      assert.equal(value.class, "browser");
      assert.match(value.token, /^[0-9a-f]{32}$/u);
      return value.token;
    }
    assert.match(reserved.stderr ?? "", /resource_busy:/u);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Browser capacity remained busy before any worker started");
}

async function evaluate(kind, output, spec, image, expectedExitCode = 0) {
  const id = `browser-test-${randomUUID()}`;
  const reservation = await reserveBrowser(id);
  const child = spawn(
    "wsl.exe",
    [
      "-d",
      "distill-bench",
      "-u",
      "root",
      "--exec",
      "/usr/bin/env",
      `DISTILL_BENCH_RESERVATION=${reservation}`,
      "/usr/local/sbin/bench-browser",
      "evaluate",
      id,
      "20",
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let text = "";
  let errors = "";
  let expired = false;
  const timeout = setTimeout(() => {
    expired = true;
    spawnSync(
      "wsl.exe",
      [
        "-d",
        "distill-bench",
        "-u",
        "root",
        "--exec",
        "/usr/local/sbin/bench-clean",
        id,
      ],
      {
        windowsHide: true,
        stdio: "ignore",
      },
    );
    child.kill();
  }, 440000);
  child.stdout.on("data", (chunk) => {
    assert.ok(
      Buffer.byteLength(text) + chunk.length <= 4 * 1024 * 1024,
      "Bounded browser envelope",
    );
    text += chunk;
  });
  child.stderr.on("data", (chunk) => {
    assert.ok(
      Buffer.byteLength(errors) + chunk.length <= 65536,
      "Bounded browser diagnostics",
    );
    errors += chunk;
  });
  child.stdin.end(
    JSON.stringify({
      kind,
      output,
      spec,
    }),
  );
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  }).finally(() => {
    clearTimeout(timeout);
    spawnSync(
      "wsl.exe",
      [
        "-d",
        "distill-bench",
        "-u",
        "root",
        "--exec",
        "/usr/local/sbin/bench-budget",
        "release",
        reservation,
      ],
      { windowsHide: true, stdio: "ignore", timeout: 10000 },
    );
  });
  assert.equal(
    expired,
    false,
    "Worker did not finish within admission and execution budgets",
  );
  assert.equal(code, expectedExitCode, `${text}\n${errors}`);
  const envelope = JSON.parse(text);
  if (image && envelope.screenshot)
    await writeFile(
      join(evidence, `${image}-${Date.now()}.png`),
      Buffer.from(envelope.screenshot, "base64"),
    );
  return envelope.result ?? envelope;
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

test("candidate navigation cannot turn protected Linux files into an artifact", async () => {
  const result = await evaluate(
    "browser",
    '<script>location.href="file:///workspace/request.json"</script><output>Fixture</output>',
    { steps: [{ action: "expectText", selector: "output", value: "Fixture" }] },
  );
  // Chromium/route policy can reject the navigation before it occurs. If the
  // frame changes, the independent controller closes it and refuses its image.
  if (result.candidatePolicyViolation)
    assert.equal(result.candidatePolicyViolation, "artifact_navigation");
  else assert.equal(result.boundary.node, "undefined");
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

test("option selection uses the value regardless of position or label", async () => {
  const result = await evaluate(
    "browser",
    '<label>Theme<select id="theme"><option value="dusk">Morning</option><option value="dawn">Evening</option></select></label><output id="events"></output><script>const select=document.querySelector("select");const events=[];for(const type of ["input","change"])select.addEventListener(type,()=>{events.push(type+":"+select.value);document.querySelector("output").textContent=events.join(",");});</script>',
    {
      steps: [
        { action: "selectOption", selector: "#theme", value: "dawn" },
        { action: "expectValue", selector: "#theme", value: "dawn" },
        {
          action: "expectText",
          selector: "#events",
          value: "input:dawn,change:dawn",
        },
        { action: "selectOption", selector: "#theme", value: "dusk" },
        { action: "expectValue", selector: "#theme", value: "dusk" },
        { action: "selectOption", selector: "#theme", value: "absent" },
        { action: "expectValue", selector: "#theme", value: "dusk" },
        { action: "selectOption", selector: "#theme", value: 0 },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, true, true, true, true, false, true, false],
  );
});

test("rendered size assertions accept equivalent layouts and reject forged geometry", async () => {
  const result = await evaluate(
    "browser",
    '<style>#css{width:120px;height:60px;box-sizing:border-box;border:2px solid;transform:scale(1.5);transform-origin:top left}#fractional{width:120.25px;height:60.25px}#forged{width:12px;height:6px}#hidden{display:none}</style><div id="css"></div><svg id="attribute" width="180" height="90"></svg><div id="fractional"></div><div id="forged"></div><div id="hidden"></div><script>document.querySelector("#forged").getBoundingClientRect=()=>({width:180,height:90,x:0,y:0});Element.prototype.getBoundingClientRect=()=>({width:180,height:90,x:0,y:0});</script>',
    {
      steps: [
        ...["css", "attribute"].map((id) => ({
          action: "expectSize",
          selector: `#${id}`,
          value: { width: 180, height: 90, tolerance: 0 },
        })),
        {
          action: "expectSize",
          selector: "#fractional",
          value: { width: 120, height: 60 },
        },
        {
          action: "expectSize",
          selector: "#fractional",
          value: { width: 120, height: 60, tolerance: 0.1 },
        },
        ...["#forged", "#hidden", "#missing", "#css,#attribute"].map(
          (selector) => ({
            action: "expectSize",
            selector,
            value: { width: 180, height: 90 },
          }),
        ),
        ...[
          null,
          [],
          { width: "180", height: 90 },
          { width: 180 },
          { width: -1, height: 90 },
          { width: 180, height: 90, tolerance: -1 },
          { width: 180, height: 90, tolerance: null },
          { width: Infinity, height: 90 },
        ].map((value) => ({
          action: "expectSize",
          selector: "#attribute",
          value,
        })),
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, true, true, ...Array(13).fill(false)],
  );
});

test("rendered bounds use native geometry and optional relative origins", async () => {
  const relative = {
    x: 19,
    y: 24,
    width: 53,
    height: 28,
    relativeTo: "#canvas",
    tolerance: 0,
  };
  const cases = [
    ["#decimal", relative, true],
    ["#translated", relative, true],
    ["#decimal", { x: 59, y: 94, width: 53, height: 28 }, true],
    [
      "#negative",
      { x: -5.25, y: -7.5, width: 11.5, height: 6.5, tolerance: 0 },
      true,
    ],
    [
      "#child",
      { x: -4, y: -6, width: 20, height: 10, relativeTo: "#frame" },
      true,
    ],
    ["#decimal", { ...relative, x: 19.2, tolerance: undefined }, true],
    ["#decimal", { ...relative, x: 19.2, tolerance: 0.1 }, false],
    ["#forged", relative, false],
    ["#hidden", relative, false],
    ["#missing", relative, false],
    ["[", relative, false],
    ["#decimal >> nth=0", relative, false],
    ["#decimal,#translated", relative, false],
    ...["#hidden", "#missing", "#canvas,#frame", "["].map((relativeTo) => [
      "#decimal",
      { ...relative, relativeTo },
      false,
    ]),
    ...[
      null,
      [],
      { ...relative, x: "19" },
      { ...relative, y: null },
      { ...relative, x: Infinity },
      { ...relative, width: -1 },
      { ...relative, height: undefined },
      { ...relative, tolerance: -1 },
      { ...relative, tolerance: null },
      { ...relative, relativeTo: null },
      { ...relative, relativeTo: "" },
      { ...relative, relativeTo: " " },
      { ...relative, relativeTo: "a".repeat(1001) },
    ].map((value) => ["#decimal", value, false]),
  ];
  const result = await evaluate(
    "browser",
    '<style>body{margin:0}#canvas{position:absolute;left:40px;top:70px;width:240px;height:120px}#negative{position:absolute;left:-5.25px;top:-7.5px;width:11.5px;height:6.5px}#frame{position:absolute;left:400px;top:200px;width:100px;height:100px}#child{position:absolute;left:-4px;top:-6px;width:20px;height:10px}#hidden{display:none}</style><svg id="canvas" viewBox="0 0 120 60"><rect id="decimal" x="9.50" y="12.0" width="26.50" height="14.0"/><g transform="translate(9.5,12)"><rect id="translated" x="0" y="0" width="26.5" height="14"/></g><rect id="forged" x="50" y="40" width="3" height="2"/></svg><div id="negative"></div><div id="frame"><div id="child"></div></div><div id="hidden"></div><script>Element.prototype.getBoundingClientRect=()=>({x:59,y:94,width:53,height:28});document.querySelector("#forged").getBoundingClientRect=()=>({x:59,y:94,width:53,height:28});document.querySelector("#canvas").getBoundingClientRect=()=>({x:0,y:0,width:240,height:120});</script>',
    {
      steps: cases.map(([selector, value]) => ({
        action: "expectBounds",
        selector,
        value,
      })),
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    cases.map(([, , expected]) => expected),
  );
});

test("rendered bounds stay coherent while a shared ancestor moves", async () => {
  const motion = [
    '<script>const parent=document.querySelector("#moving");let frame=0;function move(){parent.style.transform="translate("+(frame++%2*160)+"px,"+(frame%2*90)+"px)";requestAnimationFrame(move)}move();</script>',
    "<style>@keyframes move{from{transform:translate(0,0)}to{transform:translate(280px,130px)}}#moving{animation:move 73ms linear infinite alternate}</style>",
  ];
  for (const animation of motion) {
    const result = await evaluate(
      "browser",
      '<style>body{margin:0}#moving{position:absolute;left:23px;top:41px}svg{display:block}</style><div id="moving"><svg id="surface" width="210" height="125"><g transform="translate(13.25,17.5)"><rect id="tile" width="63" height="37"/></g></svg></div>' +
        animation,
      {
        steps: Array.from({ length: 100 }, () => ({
          action: "expectBounds",
          selector: "#tile",
          value: {
            x: 13.25,
            y: 17.5,
            width: 63,
            height: 37,
            relativeTo: "#surface",
            tolerance: 0.001,
          },
        })),
      },
    );
    assert.equal(result.checks.length, 100);
    assert.equal(
      result.pass,
      true,
      JSON.stringify(result.checks.filter((check) => !check.pass)),
    );
  }
});

test("SVG rectangle bounds use viewport coordinates and native transformed corners", async () => {
  const bounds = {
    x: -7,
    y: 11,
    width: 36,
    height: 22,
    relativeTo: "#surface",
    coordinateSpace: "svg",
    tolerance: 0.001,
  };
  const cases = [
    ...["#decimal", "#translated", "#reflected", "#quarter", "#css"].map(
      (selector) => [selector, bounds, true],
    ),
    ["#decimal", { ...bounds, x: -6.8, tolerance: undefined }, true],
    ["#decimal", { ...bounds, x: -6.8 }, false],
    ["#decimal", { ...bounds, width: 35 }, false],
    ["#wrong", bounds, false],
    ["#hidden", bounds, false],
    ["#ellipse", bounds, false],
    ["#wrapper", bounds, false],
    ["#surface", bounds, false],
    ["#decimal,#translated", bounds, false],
    ["#decimal", { ...bounds, relativeTo: "#wrapper" }, false],
    ["#decimal", { ...bounds, relativeTo: "#html" }, false],
    ["#decimal", { ...bounds, relativeTo: "#singular" }, false],
    ["#decimal", { ...bounds, relativeTo: undefined }, false],
    ...[null, "world", 1, true].map((coordinateSpace) => [
      "#decimal",
      { ...bounds, coordinateSpace },
      false,
    ]),
    ["#skew", { ...bounds, x: 0, y: 0, width: 30, height: 20 }, false],
    [
      "#diamond",
      {
        ...bounds,
        x: -Math.sqrt(50),
        y: 0,
        width: Math.sqrt(200),
        height: Math.sqrt(200),
      },
      false,
    ],
  ];
  const result = await evaluate(
    "browser",
    `<style>body{margin:0}#html{transform:translate(19px,31px) scale(1.3) rotate(9deg);transform-origin:0 0}#surface{box-sizing:border-box;width:260px;height:170px;border:3px solid;padding:7px 11px}#css{x:-7px;y:11px;width:36px;height:22px}</style>
    <div id="html"><svg id="surface" viewBox="-30 -20 130 85">
    <rect id="decimal" x="-7.00" y="11.0" width="36.0" height="22.00" rx="3"/>
    <g id="wrapper" transform="translate(-7,11)"><rect id="translated" width="36" height="22"/></g>
    <rect id="reflected" width="36" height="22" transform="matrix(-1 0 0 1 29 11)"/>
    <rect id="quarter" width="22" height="36" transform="translate(29 11) rotate(90)"/>
    <rect id="css" x="80" y="60" width="2" height="3"/>
    <rect id="wrong" x="-6" y="11" width="36" height="22"/>
    <rect id="hidden" x="-7" y="11" width="36" height="22" style="display:none"/>
    <ellipse id="ellipse" cx="11" cy="22" rx="18" ry="11"/>
    <rect id="skew" width="20" height="20" transform="matrix(1 0 0.5 1 0 0)"/>
    <rect id="diamond" width="10" height="10" transform="rotate(45)"/>
    </svg><svg id="singular" style="transform:scale(0)" width="100" height="100"></svg></div>
    <script>
    SVGGraphicsElement.prototype.getBBox=()=>({x:-7,y:11,width:36,height:22});
    SVGGraphicsElement.prototype.getScreenCTM=()=>new DOMMatrix();
    DOMMatrixReadOnly.prototype.inverse=()=>new DOMMatrix();
    DOMMatrixReadOnly.prototype.multiply=()=>new DOMMatrix();
    DOMMatrixReadOnly.prototype.transformPoint=()=>({x:-7,y:11});
    SVGMatrix.prototype.inverse=()=>({a:1,b:0,c:0,d:1,e:0,f:0});
    SVGMatrix.prototype.multiply=()=>({a:1,b:0,c:0,d:1,e:0,f:0});
    SVGPoint.prototype.matrixTransform=()=>({x:-7,y:11});
    document.querySelector('#wrong').getBBox=()=>({x:-7,y:11,width:36,height:22});
    window.SVGRectElement=Element;
    </script>`,
    {
      steps: cases.map(([selector, value]) => ({
        action: "expectBounds",
        selector,
        value,
      })),
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    cases.map(([, , pass]) => pass),
  );
});

test("SVG viewport coordinates stay coherent during ancestor motion and zoom", async () => {
  const animations = [
    '<script>const host=document.querySelector("#host");let n=0;function move(){host.style.transform="translate("+(n++%2*83)+"px,17px) scale("+(1+n%2)+")";requestAnimationFrame(move)}move()</script>',
    "<style>@keyframes move{from{transform:translate(0,0) scale(.8)}to{transform:translate(113px,57px) scale(1.7)}}#host{animation:move 83ms linear infinite alternate}</style>",
  ];
  for (const animation of animations) {
    const result = await evaluate(
      "browser",
      '<style>#surface{box-sizing:border-box;border:2px solid;padding:9px;width:300px;height:200px}</style><div id="host"><svg id="surface" viewBox="0 0 150 100"><g transform="translate(17 23)"><rect id="tile" width="41" height="29"/></g></svg></div>' +
        animation,
      {
        steps: Array.from({ length: 100 }, () => ({
          action: "expectBounds",
          selector: "#tile",
          value: {
            x: 17,
            y: 23,
            width: 41,
            height: 29,
            relativeTo: "#surface",
            coordinateSpace: "svg",
            tolerance: 0.001,
          },
        })),
      },
    );
    assert.equal(result.checks.length, 100);
    assert.equal(
      result.pass,
      true,
      JSON.stringify(result.checks.filter((check) => !check.pass)),
    );
  }
});

test("opt-in settling observes delayed geometry without repeating an action", async () => {
  const result = await evaluate(
    "browser",
    '<style>#tile{position:absolute;left:32px;top:48px;width:11px;height:9px}</style><div id="tile"></div><button id="save" type="button">Save</button><output id="calls">0</output><script>let calls=0;document.querySelector("#save").onclick=()=>{document.querySelector("#calls").textContent=String(++calls);setTimeout(()=>{document.querySelector("#tile").style.width="80px";document.querySelector("#tile").style.height="40px";},250);};</script>',
    {
      timeoutSeconds: 30,
      steps: [
        { action: "click", selector: "#save", timeoutMs: 1000 },
        {
          action: "expectBounds",
          selector: "#tile",
          timeoutMs: 1000,
          value: { x: 32, y: 48, width: 80, height: 40 },
        },
        { action: "expectText", selector: "#calls", value: "1" },
      ],
    },
  );
  assert.equal(result.pass, true);
});

test("action readiness can exceed the legacy timeout and expired assertions stay failed", async () => {
  const result = await evaluate(
    "browser",
    '<output id="state">Waiting</output><script>setTimeout(()=>{document.body.insertAdjacentHTML("beforeend",\'<button id="late" type="button">Run</button>\');document.querySelector("#state").textContent="Ready";document.querySelector("#late").onclick=()=>{document.querySelector("#state").textContent="Clicked";};},1800);</script>',
    {
      steps: [
        {
          action: "expectText",
          selector: "#state",
          value: "Ready",
          timeoutMs: 60,
        },
        { action: "click", selector: "#late", timeoutMs: 3000 },
        { action: "expectText", selector: "#state", value: "Clicked" },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [false, true, true],
  );
});

test("accessibility retries restore scripts between observations and after timeout", async () => {
  const result = await evaluate(
    "browser",
    '<input id="field" aria-label="Handle" aria-invalid="true" aria-errormessage="error"><p id="error">Pending</p><button id="check" type="button">Check</button><output id="state">Waiting</output><script>setTimeout(()=>{document.querySelector("#error").textContent="Choose a unique handle.";},250);document.querySelector("#check").onclick=()=>{document.querySelector("#state").textContent="Running";};</script>',
    {
      steps: [
        {
          action: "expectAccessibleError",
          selector: "#field",
          value: "Choose a unique handle.",
          timeoutMs: 1500,
        },
        {
          action: "expectAccessibleError",
          selector: "#field",
          value: "Never present",
          timeoutMs: 80,
        },
        { action: "click", selector: "#check" },
        { action: "expectText", selector: "#state", value: "Running" },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, false, true, true],
  );
});

test("accessibility polling preserves pending timers and animation promises", async () => {
  const result = await evaluate(
    "browser",
    '<input id="field" aria-label="Handle" aria-invalid="true" aria-errormessage="error"><p id="error">Pending</p><output id="timers">0</output><button id="start" type="button">Start</button><script>document.querySelector("#start").onclick=()=>{let timers=0;for(let i=1;i<=12;i++)setTimeout(()=>{document.querySelector("#timers").textContent=String(++timers);},25*i);new Promise(resolve=>{let frames=0;function tick(){if(++frames===8)resolve();else requestAnimationFrame(tick);}requestAnimationFrame(tick);}).then(()=>{document.querySelector("#error").textContent="Ready to continue.";});};</script>',
    {
      steps: [
        { action: "click", selector: "#start" },
        {
          action: "expectAccessibleError",
          selector: "#field",
          value: "Ready to continue.",
          timeoutMs: 2000,
        },
        {
          action: "expectText",
          selector: "#timers",
          value: "12",
          timeoutMs: 2000,
        },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, true, true],
  );
});

test("failure policy records the failed step and only stops when enabled", async () => {
  for (const stopOnFailure of [false, true]) {
    const result = await evaluate(
      "browser",
      '<output id="state">Ready</output>',
      {
        stopOnFailure,
        steps: [
          { action: "expectText", selector: "#state", value: "Ready" },
          {
            action: "expectText",
            selector: "#state",
            value: "Missing",
            timeoutMs: 40,
          },
          { action: "expectText", selector: "#state", value: "Ready" },
        ],
      },
    );
    assert.deepEqual(
      result.checks.map((check) => check.pass),
      stopOnFailure ? [true, false] : [true, false, true],
    );
  }
});

test("browser timing options reject malformed and out-of-range limits", async () => {
  const step = { action: "expectText", selector: "output", value: "Ready" };
  for (const spec of [
    ...[0, 5001, 1.5, null, true, "100"].map((timeoutMs) => ({
      steps: [{ ...step, timeoutMs }],
    })),
    ...[0, 1201, null, true, 1.5, "60"].map((timeoutSeconds) => ({
      steps: [step],
      timeoutSeconds,
    })),
    { steps: [step], stopOnFailure: "true" },
  ]) {
    const result = await evaluate(
      "browser",
      "<output>Ready</output>",
      spec,
      undefined,
      1,
    );
    assert.match(result.error, /Isolated browser broker failed/);
  }
});

test("browser capacity accepts its inclusive bounds and rejects excess steps", async () => {
  const step = { action: "expectText", selector: "output", value: "Ready" };
  for (const [count, timeoutSeconds] of [
    [1, 601],
    [200, 1200],
  ]) {
    const result = await evaluate("browser", "<output>Ready</output>", {
      steps: Array.from({ length: count }, () => ({ ...step })),
      timeoutSeconds,
    });
    assert.equal(result.pass, true);
    assert.equal(result.checks.length, count);
    assert.equal(
      result.checks.every((check) => check.pass),
      true,
    );
  }
  const rejected = await evaluate(
    "browser",
    "<output>Ready</output>",
    { steps: Array.from({ length: 201 }, () => ({ ...step })) },
    undefined,
    1,
  );
  assert.match(rejected.error, /Isolated browser broker failed/);
});

test("accessible assertions use computed text and preserve equivalent markup", async () => {
  const result = await evaluate(
    "browser",
    '<label for="direct">Handle</label><input id="direct" aria-describedby="hint"><p id="hint">Use a short handle.</p><label>Alias<input id="wrapper" aria-describedby="group"></label><div id="group"><span>Use a short handle.</span></div><label>Tag<input id="multiple" aria-describedby="first second"></label><span id="first">Use a</span><span id="second">short handle.</span><input id="inline" aria-label="Handle" aria-description="Use a short handle."><input id="hidden-reference" aria-label="Handle" aria-describedby="hidden-hint"><p hidden id="hidden-hint">Use a short handle.</p><input id="missing" aria-label="Handle" aria-describedby="absent"><input id="empty" aria-label="Handle"><input hidden id="ignored" aria-label="Handle" aria-description="Use a short handle."><script>document.querySelector("#missing").getAttribute=()=>"Use a short handle.";</script>',
    {
      steps: [
        ...["direct", "wrapper", "multiple", "inline", "hidden-reference"].map(
          (id) => ({
            action: "expectAccessibleDescription",
            selector: `#${id}`,
            value: "Use a short handle.",
          }),
        ),
        {
          action: "expectAccessibleName",
          selector: "#direct",
          value: "Handle",
        },
        {
          action: "expectAccessibleName",
          selector: "#wrapper",
          value: "Alias",
        },
        { action: "expectAccessibleName", selector: "#inline" },
        {
          action: "expectAccessibleDescription",
          selector: "#empty",
          value: "",
        },
        ...["missing", "ignored", "absent"].map((id) => ({
          action: "expectAccessibleDescription",
          selector: `#${id}`,
          value: "Use a short handle.",
        })),
        {
          action: "expectAccessibleDescription",
          selector: "#direct",
          value: "Wrong hint.",
        },
        { action: "expectAccessibleName", selector: "#direct", value: "Alias" },
        {
          action: "expectAccessibleDescription",
          selector: "input",
          value: "Use a short handle.",
        },
        { action: "expectAccessibleDescription", selector: "#direct" },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [...Array(9).fill(true), ...Array(7).fill(false)],
  );
});

test("accessible errors require browser-exposed text rather than DOM ancestry", async () => {
  const cases = [
    ["direct-description", true],
    ["wrapper-description", true],
    ["multiple-description", true],
    ["inline-description", true],
    ["direct-error", true],
    ["wrapper-error", true],
    ["multiple-error", true],
    ["fragmented-error", true],
    ["inactive-error", false],
    ["hidden-error", false],
    ["missing-reference", false],
    ["wrong-target", false],
    ["unrelated", false],
    ["absent", false],
    ["ignored-control", false],
    ["excluded-description", false],
    ["excluded-error", false],
    ["overridden-description", false],
    ["overridden-error", false],
    ["labelled-group-error", false],
    ["labelled-image-error", false],
  ];
  const result = await evaluate(
    "browser",
    '<div id="container"><p id="error">Choose a unique handle.</p></div><p id="help">Letters are allowed.</p><p id="hidden-text" hidden>Choose a unique handle.</p><div id="excluded">Letters are allowed.<span aria-hidden="true">Choose a unique handle.</span></div><div id="overridden" aria-label="Letters are allowed."><span>Choose a unique handle.</span></div><div id="fragmented"><span>Cho</span><span>ose a <strong>unique</strong> handle.</span></div><div role="group" id="labelled-group" aria-labelledby="help"><span>Choose a unique handle.</span></div><div role="img" id="labelled-image" aria-label="Letters are allowed."><span>Choose a unique handle.</span></div><input id="labelled-group-error" aria-label="Handle" aria-invalid="true" aria-errormessage="labelled-group"><input id="labelled-image-error" aria-label="Handle" aria-invalid="true" aria-errormessage="labelled-image">' +
      '<input id="direct-description" aria-label="Handle" aria-describedby="error"><input id="wrapper-description" aria-label="Handle" aria-describedby="container"><input id="multiple-description" aria-label="Handle" aria-describedby="help error"><input id="inline-description" aria-label="Handle" aria-description="Letters are allowed. Choose a unique handle."><input id="direct-error" aria-label="Handle" aria-invalid="true" aria-errormessage="error"><input id="wrapper-error" aria-label="Handle" aria-invalid="true" aria-errormessage="container"><input id="multiple-error" aria-label="Handle" aria-invalid="true" aria-errormessage="help error"><input id="fragmented-error" aria-label="Handle" aria-invalid="true" aria-errormessage="fragmented"><input id="inactive-error" aria-label="Handle" aria-invalid="false" aria-errormessage="error"><input id="hidden-error" aria-label="Handle" aria-invalid="true" aria-errormessage="hidden-text"><input id="missing-reference" aria-label="Handle" aria-describedby="absent"><input id="wrong-target" aria-label="Handle" aria-describedby="help"><input id="unrelated" aria-label="Handle"><input hidden id="ignored-control" aria-label="Handle" aria-describedby="error"><input id="excluded-description" aria-label="Handle" aria-describedby="excluded"><input id="excluded-error" aria-label="Handle" aria-invalid="true" aria-errormessage="excluded"><input id="overridden-description" aria-label="Handle" aria-describedby="overridden"><input id="overridden-error" aria-label="Handle" aria-invalid="true" aria-errormessage="overridden"><script>Node.prototype.contains=()=>true;document.querySelector("#wrong-target").getAttribute=()=>"error";</script>',
    {
      steps: [
        ...cases.map(([control]) => ({
          action: "expectAccessibleError",
          selector: `#${control}`,
          value: "Choose a unique handle.",
        })),
        ...["", "   ", undefined, 1].map((value) => ({
          action: "expectAccessibleError",
          selector: "#direct-error",
          value,
        })),
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [...cases.map(([, pass]) => pass), false, false, false, false],
  );
});

test("error readback preserves text boundaries and ignores candidate realm overrides", async () => {
  const result = await evaluate(
    "browser",
    '<input id="inline-field" aria-label="Handle" aria-invalid="true" aria-errormessage="inline"><div id="inline"><span>Choose a unique ha</span><span>ndle.</span></div><input id="block-field" aria-label="Handle" aria-invalid="true" aria-errormessage="block"><div id="block"><p>Choose a unique ha</p><p>ndle.</p></div><input id="words-field" aria-label="Handle" aria-invalid="true" aria-errormessage="words"><div id="words"><p>Choose a</p><p>unique handle.</p></div><input id="styled-field" aria-label="Handle" aria-invalid="true" aria-errormessage="styled"><div id="styled"><p style="display:inline">Choose a unique ha</p><p style="display:inline">ndle.</p></div><output id="probe">Untouched</output><script>const probe=document.querySelector("#probe");const mark=()=>{probe.innerHTML="Candidate getter called";};Element.prototype.getAttribute=()=>{mark();return "inline";};Object.defineProperty(Node.prototype,"textContent",{get(){mark();return "Choose a unique handle.";}});window.getComputedStyle=()=>{mark();return {display:"inline",visibility:"visible"};};RegExp.prototype.test=()=>true;String.prototype.includes=()=>true;JSON.stringify=()=>"forged";</script>',
    {
      steps: [
        ...["inline-field", "block-field", "words-field", "styled-field"].map(
          (id) => ({
            action: "expectAccessibleError",
            selector: `#${id}`,
            value: "Choose a unique handle.",
          }),
        ),
        { action: "expectText", selector: "#probe", value: "Untouched" },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, false, true, true, true],
  );
});

test("only active error references contribute and readback restores candidate behavior", async () => {
  const hiddenStyles = [
    "hidden",
    'style="display:none"',
    'aria-hidden="true"',
    'style="visibility:hidden"',
  ];
  const fields = hiddenStyles
    .map(
      (attrs, i) =>
        `<input id="field-${i}" aria-label="Handle" aria-invalid="true" aria-errormessage="help hidden-${i}"><p id="hidden-${i}" ${attrs}>Choose a unique handle.</p>`,
    )
    .join("");
  const result = await evaluate(
    "browser",
    `${fields}<p id="help">Letters are allowed.</p><p id="good">Choose a unique handle.</p><input id="mixed-good" aria-label="Handle" aria-invalid="true" aria-errormessage="help good good hidden-0"><output id="state">Ready</output><button id="verify" type="button">Verify</button><script>const field=document.querySelector("#mixed-good");const custom=()=>"Unrelated";field.getAttribute=custom;let mutations=0;new MutationObserver(records=>{mutations+=records.length;}).observe(field,{attributes:true});document.querySelector("#verify").onclick=()=>{document.querySelector("#state").textContent=field.getAttribute===custom&&mutations===0?"Restored":"Changed";};</script>`,
    {
      steps: [
        ...hiddenStyles.map((_, i) => ({
          action: "expectAccessibleError",
          selector: `#field-${i}`,
          value: "Choose a unique handle.",
        })),
        {
          action: "expectAccessibleError",
          selector: "#mixed-good",
          value: "Choose a unique handle.",
        },
        {
          action: "expectAccessibleError",
          selector: "#mixed-good",
          value: "Letters are allowed. Choose a unique handle.",
        },
        {
          action: "expectAccessibleError",
          selector: "#mixed-good",
          value: "Choose a unique handle. Letters are allowed.",
        },
        {
          action: "expectCount",
          selector: '#mixed-good[aria-errormessage="help good good hidden-0"]',
          value: 1,
        },
        { action: "click", selector: "#verify" },
        { action: "expectText", selector: "#state", value: "Restored" },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [false, false, false, false, true, true, false, true, true, true],
  );
});

test("reflected error relations support unnamed targets without changing the DOM", async () => {
  const result = await evaluate(
    "browser",
    '<input id="direct" aria-label="Handle" aria-invalid="true"><input id="wrapper" aria-label="Handle" aria-invalid="true"><input id="mixed-hidden" aria-label="Handle" aria-invalid="true"><input id="mixed-good" aria-label="Handle" aria-invalid="true"><p>Choose a unique handle.</p><section><span id="named-error">Choose a unique handle.</span></section><p>Letters are allowed.</p><p hidden>Choose a unique handle.</p><output id="state">Ready</output><button id="verify" type="button">Verify</button><script>const fields=[...document.querySelectorAll("input")];const [direct,help,hidden]=document.querySelectorAll("p");const wrapper=document.querySelector("section");fields[0].ariaErrorMessageElements=[direct];fields[1].ariaErrorMessageElements=[wrapper];fields[2].ariaErrorMessageElements=[help,hidden];fields[3].ariaErrorMessageElements=[help,direct,hidden];const attributes=fields.map(node=>node.getAttribute("aria-errormessage"));const state=document.querySelector("#state");const verify=document.querySelector("#verify");const original=document.querySelector;const custom=function(selector){return original.call(this,selector);};document.querySelector=custom;let mutations=0;new MutationObserver(records=>{mutations+=records.length;}).observe(document,{attributes:true,subtree:true});verify.onclick=()=>{state.textContent=document.querySelector===custom&&mutations===0&&[direct,help,hidden,wrapper].every(node=>!node.hasAttribute("id"))&&fields.every((node,index)=>node.getAttribute("aria-errormessage")===attributes[index])?"Restored":"Changed";};</script>',
    {
      steps: [
        ...["direct", "wrapper", "mixed-hidden", "mixed-good"].map((id) => ({
          action: "expectAccessibleError",
          selector: `#${id}`,
          value: "Choose a unique handle.",
        })),
        {
          action: "expectAccessibleError",
          selector: "#mixed-good",
          value: "Letters are allowed. Choose a unique handle.",
        },
        {
          action: "expectAccessibleError",
          selector: "#mixed-good",
          value: "Choose a unique handle. Letters are allowed.",
        },
        {
          action: "expectCount",
          selector: 'input[aria-errormessage=""]',
          value: 4,
        },
        { action: "click", selector: "#verify" },
        { action: "expectText", selector: "#state", value: "Restored" },
      ],
    },
  );
  assert.deepEqual(
    result.checks.map((check) => check.pass),
    [true, true, false, true, true, false, true, true, true],
  );
});

test("failed interaction completes with bounded disposable Linux profile cleanup", async () => {
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
