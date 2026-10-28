// Explicit administrator qualification, never run by an ordinary benchmark.
// It copies only this allowlist of public infrastructure into a fresh offline
// Linux probe namespace. Synthetic credentials and loopback requests prove the
// policy; a protected local receipt binds the source and Linux executables.
// Usage: node scripts/benchmark-linux-text-policy-probe.mjs claude|codex|grok|kimi|zai
//        node scripts/benchmark-linux-text-policy-probe.mjs --self-test
//        node scripts/benchmark-linux-text-policy-probe.mjs --measure-cache codex
// Add --diagnostic to run the suite without installing a proof receipt.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const repo = new URL("../", import.meta.url);
const source = async (path) => readFile(new URL(path, repo), "utf8");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const adapters = {
  claude: "benchmark-claude-policy.mjs",
  codex: "benchmark-codex-policy.mjs",
  kimi: "benchmark-linux-text-kimi.mjs",
  zai: "benchmark-zai-policy.mjs",
};
const resources = "src-tauri/resources/";
const allowed = [
  "scripts/benchmark-native-policy-probe.mjs",
  "scripts/benchmark-provider-policy-probe.mjs",
  "scripts/benchmark-linux-text-probe-entry.mjs",
  "src-tauri/src/services/agent_host/execution.rs",
  `${resources}benchmark-native-policies.json`,
  `${resources}benchmark-claude-policy.mjs`,
  `${resources}benchmark-codex-policy.mjs`,
  `${resources}benchmark-kimi-policy.mjs`,
  `${resources}benchmark-linux-text-kimi.mjs`,
  `${resources}benchmark-linux-text-bootstrap.mjs`,
  `${resources}benchmark-zai-policy.mjs`,
];

function tar(files) {
  const chunks = [];
  for (const [name, contents] of files) {
    assert(
      /^[a-zA-Z0-9_./-]+$/.test(name) &&
        !name.split("/").includes("..") &&
        Buffer.byteLength(name) < 100,
    );
    const data = Buffer.from(contents);
    const header = Buffer.alloc(512);
    const octal = (offset, width, value) =>
      header.write(
        `${value.toString(8).padStart(width - 1, "0")}\0`,
        offset,
        width,
        "ascii",
      );
    header.write(name, 0, "utf8");
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, data.length);
    octal(136, 12, 0);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((total, byte) => total + byte, 0);
    header.write(
      `${checksum.toString(8).padStart(6, "0")}\0 `,
      148,
      8,
      "ascii",
    );
    chunks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

function bounded(
  program,
  args,
  { input, timeout = 120_000, cap = 256 * 1024 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let total = 0,
      failed;
    const out = [],
      err = [];
    const stop = (message) => {
      failed ??= new Error(message);
      child.kill();
    };
    const timer = setTimeout(
      () => stop("Linux policy control exceeded its deadline"),
      timeout,
    );
    for (const [stream, chunks] of [
      [child.stdout, out],
      [child.stderr, err],
    ])
      stream.on("data", (bytes) => {
        total += bytes.length;
        if (total > cap) stop("Linux policy control exceeded its output bound");
        else chunks.push(bytes);
      });
    child.on("error", (error) => {
      failed = error;
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.on("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (failed) reject(failed);
      else if (code !== 0)
        reject(
          new Error(
            `Linux policy command failed (${code}): ${stderr.slice(-8192)}`,
          ),
        );
      else resolve({ stdout, stderr });
    });
  });
}

async function linux(program, args = [], options = {}) {
  // This administrator driver requires the Windows host's fresh headroom
  // sample. It cannot be run from an arbitrary Linux machine with fake caps.
  assert.equal(
    process.platform,
    "win32",
    "Run qualification from the Windows source checkout",
  );
  return bounded(
    "wsl.exe",
    ["-d", "distill-bench", "-u", "root", "--exec", program, ...args],
    options,
  );
}

const HEADROOM = String.raw`
$ErrorActionPreference='Stop'
$os=Get-CimInstance Win32_OperatingSystem
$memory=Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory
$distro=Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | Get-ItemProperty | Where-Object DistributionName -eq 'distill-bench'
if (@($distro).Count -ne 1) { throw 'Sandbox registration is missing or ambiguous' }
$volume=[System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($distro.BasePath))
$ram=[uint64]$os.FreePhysicalMemory*1024
$commit=[uint64]$memory.CommitLimit-[uint64]$memory.CommittedBytes
$disk=[uint64]$volume.AvailableFreeSpace
# bench-budget adds the probe's measured claim and outstanding reservations.
if ($ram -lt 2GB -or $commit -lt 2GB -or $disk -lt 30GB) { throw 'resource_busy: Windows headroom is below policy qualification floor' }
# The fifth field is the host CPU share in thousandths; 1001 = not sampled.
Write-Output "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),$ram,$commit,$disk,1001"
`;

async function gated(program, args = [], options = {}) {
  const { stdout } = await bounded(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", HEADROOM],
    { timeout: 15_000, cap: 4096 },
  );
  const gate = stdout.trim();
  assert(/^\d+,\d+,\d+,\d+,\d+$/.test(gate), "Invalid Windows headroom sample");
  return linux(
    "/usr/bin/env",
    [`DISTILL_BENCH_HOST_GATE=${gate}`, program, ...args],
    options,
  );
}

async function attest(script, args, options = {}) {
  return gated(
    "/usr/local/sbin/bench-budget",
    ["control", "--", "/usr/bin/python3", "-c", script, ...args],
    options,
  );
}

async function inputs(provider) {
  const policies = JSON.parse(
    await source(`${resources}benchmark-native-policies.json`),
  );
  const fingerprint = digest(
    canonical({
      recipe: "linux-native-text-v1",
      provider,
      policies,
      adapter: adapters[provider]
        ? await source(resources + adapters[provider])
        : null,
      bootstrap: await source(`${resources}benchmark-linux-text-bootstrap.mjs`),
      attestation: await source(
        `${resources}benchmark-linux-text-attestation.py`,
      ),
      launcher: await source(
        "src-tauri/src/services/agent_host/text_execution.rs",
      ),
      contract: await source("src-tauri/src/services/agent_host/execution.rs"),
      router: await source("src-tauri/src/services/agent_host/router.rs"),
    }),
  );
  const host = await source("src-tauri/src/services/benchmark_sandbox.rs");
  const list = host.match(/const FILES:[\s\S]*?resources!\[([\s\S]*?)\];/)?.[1];
  assert(list, "Sandbox resource manifest not found");
  const names = [...list.matchAll(/"([a-z0-9.-]+)"/g)].map((match) => match[1]);
  const resourcePolicy = host.match(
    /const RESOURCE_POLICY:\s*&str\s*=\s*"([^"]+)"/,
  )?.[1];
  assert(resourcePolicy && names.length > 10);
  const pins = JSON.parse(
    await source(`${resources}benchmark-sandbox/runtime-pins.json`),
  );
  const identity = { resourcePolicy, ...pins };
  const expected = Object.entries(pins).map(
    ([key, value]) => `${key} ${value}`,
  );
  for (const name of names) {
    // Match Rust resource_hash and the provisioner's canonical Linux bytes.
    const hash = digest(
      (await source(`${resources}benchmark-sandbox/${name}`)).replaceAll(
        "\r\n",
        "\n",
      ),
    );
    identity[name] = hash;
    expected.push(`file ${name} ${hash}`);
  }
  // The source policy is both revisioned and checked live by Rust admission,
  // which also pins the aggregate each heavy-lane setting scales to.
  const budgetBlock = host.match(
    /const FIXED_BUDGET:[^=]*=\s*\[([\s\S]*?)\];/,
  )?.[1];
  assert(budgetBlock, "Sandbox admission policy not found");
  const budgets = [...budgetBlock.matchAll(/"(budget [^"]+)"/g)].map(
    (match) => match[1],
  );
  assert(budgets.length >= 4);
  expected.push("netns up", ...budgets);
  return { fingerprint, revision: digest(canonical(identity)), expected };
}

function checkStatus(status, expected) {
  const lines = new Set(
    status
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/).join(" ")),
  );
  for (const line of expected)
    assert(
      lines.has(line),
      `Sandbox differs from source; provision first (${line.split(" ").slice(0, 2).join(" ")})`,
    );
  assert(
    [...lines].some((line) => /^budget heavy-cap (off|[1-8])$/.test(line)),
    "Sandbox differs from source; provision first (budget heavy-cap)",
  );
}

const PREPARE = await source(
  `${resources}benchmark-linux-text-probe-prepare.py`,
);

async function qualify(provider) {
  assert(
    ["claude", "codex", "grok", "kimi", "zai"].includes(provider),
    "Choose claude, codex, grok, kimi or zai",
  );
  const { fingerprint, revision, expected } = await inputs(provider);
  const attestation = await source(
    `${resources}benchmark-linux-text-attestation.py`,
  );
  checkStatus((await gated("/usr/local/sbin/bench-status")).stdout, expected);
  const artifacts = JSON.parse(
    (await attest(attestation, ["inspect", provider])).stdout,
  );
  const id = `policy-${provider}-${randomUUID()}`;
  const archive = tar(
    await Promise.all(allowed.map(async (path) => [path, await source(path)])),
  );
  try {
    await gated(
      "/usr/local/sbin/bench-budget",
      ["prep", id, "--", "/usr/bin/python3", "-c", PREPARE, id],
      { input: archive },
    );
    const installed = {
      claude:
        "/opt/distill-tools/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp",
      codex:
        "/opt/distill-tools/codex-acp/node_modules/@agentclientprotocol/codex-acp",
      kimi: "/opt/distill-tools/kimi/node_modules/@moonshot-ai/kimi-code",
      grok: artifacts.grokNative?.path,
      zai: artifacts.entrypoint?.path,
    }[provider];
    const script =
      provider === "claude"
        ? "benchmark-native-policy-probe.mjs"
        : "benchmark-provider-policy-probe.mjs";
    const command = [
      "probe",
      id,
      "DISTILL_BENCH_RESOURCE_CLASS=text",
      `DISTILL_BENCH_DEADLINE_MS=${Date.now() + 12 * 60_000}`,
      "DISTILL_LINUX_POLICY_PROBE=offline-v1",
      `DISTILL_LINUX_PROBE_ARTIFACTS=${JSON.stringify(artifacts)}`,
      // bench-enter writes OpenCode's root-owned configuration home from
      // this, exactly as for an owned session.
      ...(provider === "zai"
        ? [
            `DISTILL_BENCH_OPENCODE_PLUGIN=${await source(`${resources}${adapters.zai}`)}`,
          ]
        : []),
      "--",
      "/usr/local/bin/node",
      "/workspace/scripts/benchmark-linux-text-probe-entry.mjs",
      provider,
      `/workspace/scripts/${script}`,
      ...(provider === "claude" ? [] : [provider]),
      installed,
      "--linux-sandbox",
    ];
    const output = await gated("/usr/local/sbin/bench-run", command, {
      timeout: 12 * 60_000,
    });
    const report = JSON.parse(output.stdout);
    assert.equal(
      report.status,
      "passed",
      "Loopback policy qualification did not pass",
    );
    assert(Array.isArray(report.checks) && report.checks.length >= 5);
    checkStatus((await gated("/usr/local/sbin/bench-status")).stdout, expected);
    const after = JSON.parse(
      (await attest(attestation, ["inspect", provider])).stdout,
    );
    assert.deepEqual(
      after,
      artifacts,
      "Linux executable changed during qualification",
    );
    const receipt = {
      schemaVersion: 1,
      recipe: "linux-native-text-v1",
      provider,
      sandboxRevision: revision,
      policyFingerprint: fingerprint,
      runtimeArtifacts: artifacts,
      status: "passed",
      qualifiedAt: new Date().toISOString(),
      probeReportHash: digest(canonical(report)),
    };
    const installedProof = !process.argv.includes("--diagnostic");
    if (installedProof)
      await attest(attestation, ["write", provider, revision, fingerprint], {
        input: JSON.stringify(receipt),
      });
    console.log(
      JSON.stringify(
        { ...receipt, installedProof, checks: report.checks },
        null,
        2,
      ),
    );
  } finally {
    // Native supervisor deadline and independent reaper also cover host exit.
    await linux("/usr/local/sbin/bench-clean", [id], { timeout: 30_000 });
  }
}

async function selfTest() {
  assert.equal(canonical({ z: 1, a: { b: true } }), '{"a":{"b":true},"z":1}');
  const archive = tar([["synthetic/task.txt", "invented fixture\n"]]);
  assert.equal(archive.length, 2048);
  assert.equal(archive.subarray(512, 529).toString(), "invented fixture\n");
  assert.throws(() => tar([["../escape", "bad"]]));
  const values = await Promise.all(
    ["claude", "codex", "grok", "kimi", "zai"].map(inputs),
  );
  assert.equal(new Set(values.map((value) => value.fingerprint)).size, 5);
  assert.equal(new Set(values.map((value) => value.revision)).size, 1);
  // A sandbox reports the operator's heavy-job cap besides the pinned lines.
  checkStatus(
    [...values[0].expected, "budget heavy-cap off"].join("\n"),
    values[0].expected,
  );
  assert.throws(() => checkStatus("", values[0].expected));
  assert(
    allowed.every((path) => !/private|benchmark-tasks|calibration/.test(path)),
  );
  console.log(
    "Linux text qualification driver self-test passed (no WSL or model call)",
  );
}

async function measureCache(provider) {
  assert(["claude", "codex", "grok", "kimi", "zai"].includes(provider));
  const { fingerprint, revision, expected } = await inputs(provider);
  checkStatus((await gated("/usr/local/sbin/bench-status")).stdout, expected);
  const script = await source(
    `${resources}benchmark-linux-text-attestation.py`,
  );
  const timer = `
import json, subprocess, sys, time
payload = json.load(sys.stdin)
rows, observed = [], None
for operation in ['verify-cold', 'verify', 'verify']:
    start = time.perf_counter()
    run = subprocess.run(['/usr/bin/python3', '-c', payload['script'], operation, payload['provider'], payload['revision'], payload['policy']], capture_output=True, text=True, timeout=45)
    elapsed = time.perf_counter() - start
    if run.returncode:
        sys.stderr.write(run.stderr[-8192:]); sys.exit(run.returncode)
    artifacts = json.loads(run.stdout)
    if observed is not None and artifacts != observed: raise ValueError('runtime changed between timing samples')
    observed = artifacts
    rows.append({'operation': operation, 'seconds': round(elapsed, 6)})
print(json.dumps({'provider': payload['provider'], 'samples': rows,
                  'scope': 'Linux Python verification; first forces a hash-cache miss; OS page cache is not flushed; excludes WSL launch, Windows metadata sampling and bench-status'}, indent=2))
`;
  const output = await gated(
    "/usr/local/sbin/bench-budget",
    ["control", "--", "/usr/bin/python3", "-c", timer],
    {
      input: JSON.stringify({
        script,
        provider,
        revision,
        policy: fingerprint,
      }),
      timeout: 150_000,
    },
  );
  console.log(output.stdout.trim());
}

if (process.argv[2] === "--self-test") await selfTest();
else if (process.argv[2] === "--measure-cache")
  await measureCache(process.argv[3]);
else await qualify(process.argv[2]);
