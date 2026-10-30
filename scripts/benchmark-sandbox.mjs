#!/usr/bin/env node
// Creates and provisions the WSL distribution repository benchmark cases run
// in (see src-tauri/resources/benchmark-sandbox/provision.sh). The installed
// app sets the same sandbox up itself (Settings > Benchmarks > Sandbox, or
// the run dialogs); this script is the development equivalent.
//
//   node scripts/benchmark-sandbox.mjs            provision (create if missing)
//   node scripts/benchmark-sandbox.mjs status     print bench-status
//   node scripts/benchmark-sandbox.mjs login kimi ACCOUNT-ID  Kimi sign-in (below)
//   node scripts/benchmark-sandbox.mjs selftest   check the confinement from inside
//   node scripts/benchmark-sandbox.mjs retire-grants  move the sandbox grants
//                                     leases replaced aside (root only)
//   node scripts/benchmark-sandbox.mjs deploy-helpers  network-free helper update
//   node scripts/benchmark-sandbox.mjs heavy-cap N|off  cap CPU-heavy jobs at once
//                                     (1-8); admission is dynamic without it
//   node scripts/benchmark-sandbox.mjs install-tool ID...  only those provider
//                                     tools (downloads them; helpers, users and
//                                     the browser stay as they are)
//
// Claude, Codex, Grok and Z.ai sign in once, in Distill: every session gets a
// lease of that sign-in (`bench-auth stage`), and nothing signs in here.
// Kimi alone keeps its own sandbox sign-in, made by hand once per account:
//   node scripts/benchmark-sandbox.mjs login kimi <account-id>
// It samples the Windows headroom the sandbox admits work against
// (DISTILL_BENCH_HOST_GATE) and runs bench-login in a terminal with it; a
// bare `wsl ... bench-login` carries no gate and is refused.
//
// The provider tools are the versions Distill runs on Windows: the managed
// bridges from acp-tools.lock.json (installed with npm ci from the same
// lock), the pinned Kimi Code and Grok releases and, for Z.ai, the Linux
// build of the OpenCode release the doctor installs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSelftest } from "./benchmark-sandbox-selftest.mjs";

const DISTRO = "distill-bench";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(
  repo,
  "src-tauri",
  "resources",
  "benchmark-sandbox",
);
const root = resolveFlockRoot();

// Mirrors the app's order without the identifier-keyed pointer file: the
// override, then an existing ~/.flock, then the ~/.distill folder of an
// install upgraded from Distill, else the new default.
function resolveFlockRoot() {
  const override = process.env.FLOCK_ROOT || process.env.DISTILL_ROOT;
  if (override) return override;
  const home = os.homedir();
  for (const name of [".flock", ".distill"]) {
    const candidate = path.join(home, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(home, ".flock");
}
const location = path.join(root, "benchmarks", "sandbox");
// Versions pinned by the native benchmark policies, shared with the app's
// own sandbox setup (and, with Node and git, with provision.sh).
const SPECS = JSON.parse(
  fs.readFileSync(path.join(resources, "runtime-sources.json"), "utf8"),
).tools;
function wsl(args, options = {}) {
  const result = spawnSync("wsl.exe", args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

function distroExists() {
  const list = wsl(["--list", "--quiet"], { encoding: "utf16le" });
  return list.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .includes(DISTRO);
}

function create() {
  fs.mkdirSync(location, { recursive: true });
  const result = wsl(
    [
      "--install",
      "Ubuntu-24.04",
      "--name",
      DISTRO,
      "--location",
      location,
      "--no-launch",
      "--web-download",
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0)
    throw new Error(`wsl --install exited ${result.status}`);
}

function stage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "distill-provision-"));
  for (const file of fs.readdirSync(resources)) {
    if (!fs.statSync(path.join(resources, file)).isFile()) continue;
    fs.writeFileSync(
      path.join(dir, file),
      fs
        .readFileSync(path.join(resources, file), "utf8")
        .replace(/\r\n/g, "\n"),
    );
  }
  fs.writeFileSync(
    path.join(dir, "benchmark-browser-worker.mjs"),
    fs
      .readFileSync(
        path.join(resources, "..", "benchmark-browser-worker.mjs"),
        "utf8",
      )
      .replace(/\r\n/g, "\n"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(repo, "acp-tools.lock.json"), "utf8"),
  );
  for (const id of ["claude-acp", "codex-acp"]) {
    const tool = lock.tools[id];
    const target = path.join(dir, "tools", id);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(
      path.join(target, "package.json"),
      `${JSON.stringify(tool.packageJson, null, 2)}\n`,
    );
    fs.writeFileSync(
      path.join(target, "package-lock.json"),
      `${JSON.stringify(tool.packageLock, null, 2)}\n`,
    );
  }
  for (const [id, spec] of Object.entries(SPECS)) {
    fs.mkdirSync(path.join(dir, "tools", id), { recursive: true });
    fs.writeFileSync(path.join(dir, "tools", id, "spec"), spec);
  }
  return dir;
}

function provision(tools = []) {
  if (tools.some((id) => !/^[a-z0-9-]+$/.test(id)))
    throw new Error("install-tool takes provider tool ids");
  if (!distroExists()) {
    if (tools.length)
      throw new Error(
        "The benchmark distribution must already exist; provision explicitly first",
      );
    create();
  }
  const dir = stage();
  for (const id of tools)
    if (!fs.existsSync(path.join(dir, "tools", id)))
      throw new Error(`No provider tool ${id}`);
  try {
    const tar = spawnSync("tar", ["-cf", "-", "-C", dir, "."], {
      maxBuffer: 1 << 28,
    });
    if (tar.status !== 0)
      throw new Error(`tar exited ${tar.status}: ${tar.stderr}`);
    const result = wsl(
      [
        "-d",
        DISTRO,
        "-u",
        "root",
        "--exec",
        "bash",
        "-c",
        "rm -rf /tmp/distill-provision && mkdir -p /tmp/distill-provision && " +
          'tar -x -C /tmp/distill-provision && bash /tmp/distill-provision/provision.sh "$@"',
        "provision",
        ...(tools.length ? ["--tools", ...tools] : []),
      ],
      { input: tar.stdout, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (result.status !== 0)
      throw new Error(`provision.sh exited ${result.status}`);
    // The boot configuration (no Windows drives, no interop) applies from the
    // next start. Installing tools alone leaves it, and running jobs, alone.
    if (!tools.length) wsl(["--terminate", DISTRO]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function status() {
  const result = wsl([
    "-d",
    DISTRO,
    "-u",
    "root",
    "--exec",
    "/usr/local/sbin/bench-status",
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}

function deployHelpers() {
  if (!distroExists())
    throw new Error(
      "The benchmark distribution must already exist; provision explicitly first",
    );
  // This update neither downloads packages nor restarts WSL. Runtime/browser
  // provisioning remains a separate explicit installation operation.
  const dir = stage();
  try {
    const tar = spawnSync("tar", ["-cf", "-", "-C", dir, "."], {
      maxBuffer: 1 << 24,
    });
    if (tar.status !== 0)
      throw new Error(`helper archive failed: ${tar.stderr}`);
    const result = wsl(
      [
        "-d",
        DISTRO,
        "-u",
        "root",
        "--exec",
        "python3",
        "-c",
        "import pathlib,subprocess,sys,tempfile; " +
          "p=tempfile.mkdtemp(prefix='distill-helper-update.',dir='/tmp'); " +
          "subprocess.run(['tar','-x','-C',p],stdin=sys.stdin.buffer,check=True); " +
          "subprocess.run(['bash',p+'/install-helpers.sh',p],check=True)",
      ],
      { input: tar.stdout, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (result.status !== 0)
      throw new Error(
        `helper deployment exited ${result.status}; retained recovery backups must be inspected`,
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function selftest() {
  runSelftest(resources);
}

function setting(name, value, valid, help) {
  if (!valid.test(value ?? "")) throw new Error(help);
  const result = wsl([
    "-d",
    DISTRO,
    "-u",
    "root",
    "--exec",
    "/usr/local/sbin/bench-budget",
    name,
    value,
  ]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0)
    throw new Error(`bench-budget ${name} exited ${result.status}`);
}

// The Windows headroom a sandbox job is admitted against, sampled as the
// probes sample it: time, free RAM, free commit, free space on the sandbox's
// volume and the host CPU share in thousandths (1001: not sampled).
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
Write-Output "$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()),$ram,$commit,$disk,1001"
`;

function hostGate() {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", HEADROOM],
    { encoding: "utf8", timeout: 15_000 },
  );
  if (result.error) throw result.error;
  const gate = (result.stdout ?? "").trim();
  if (result.status !== 0 || !/^\d+,\d+,\d+,\d+,\d+$/u.test(gate))
    throw new Error(
      `Windows headroom could not be sampled: ${(result.stderr ?? "").trim() || gate}`,
    );
  return gate;
}

/** Signs Kimi in for `account` inside the sandbox, in this terminal. */
function login(provider, account) {
  if (provider !== "kimi")
    throw new Error(
      "login takes kimi and an account id; Claude, Codex, Grok and Z.ai sign in in Distill",
    );
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(account ?? ""))
    throw new Error("login takes the account id from the application");
  const result = spawnSync(
    "wsl.exe",
    [
      "-d",
      DISTRO,
      "-u",
      "root",
      "--exec",
      "/usr/bin/env",
      `DISTILL_BENCH_HOST_GATE=${hostGate()}`,
      "/usr/local/sbin/bench-login",
      provider,
      account,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`bench-login exited ${result.status}`);
}

/**
 * Moves the Claude, Codex, Grok and Z.ai grants the sandbox kept from before
 * leases to /var/lib/distill-bench/retired-grants/<UTC date>/, root's alone
 * (`bench-auth retire`). It never deletes or overwrites; delete the folder
 * once it is checked.
 */
function retireGrants() {
  const day = new Date().toISOString().slice(0, 10);
  const result = spawnSync(
    "wsl.exe",
    [
      "-d",
      DISTRO,
      "-u",
      "root",
      "--exec",
      "/usr/local/sbin/bench-auth",
      "retire",
      day,
    ],
    { encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `bench-auth retire exited ${result.status}: ${(result.stderr ?? "").trim()}`,
    );
  process.stdout.write(result.stdout ?? "");
  console.log(
    `Retired grants are in /var/lib/distill-bench/retired-grants/${day} (root only).`,
  );
}

const [command, argument, ...rest] = process.argv.slice(2);
if (!command) provision();
else if (command === "install-tool") {
  if (!argument) throw new Error("install-tool takes at least one tool id");
  provision([argument, ...rest]);
} else if (command === "login") login(argument, rest[0]);
else if (command === "status") status();
else if (command === "selftest") selftest();
else if (command === "retire-grants") retireGrants();
else if (command === "deploy-helpers") deployHelpers();
else if (command === "heavy-cap")
  setting(
    "heavy-cap",
    argument,
    /^([1-8]|off)$/,
    "heavy-cap takes the most CPU-heavy jobs at once (1-8) or off",
  );
else throw new Error(`unknown command ${command}`);
