#!/usr/bin/env node
// Creates and provisions the WSL distribution repository benchmark cases run
// in (see src-tauri/resources/benchmark-sandbox/provision.sh).
//
//   node scripts/benchmark-sandbox.mjs            provision (create if missing)
//   node scripts/benchmark-sandbox.mjs status     print bench-status
//   node scripts/benchmark-sandbox.mjs selftest   check the confinement from inside
//
// Provider sign-in happens inside the sandbox, by hand, once per account:
//   wsl -d distill-bench -u root bench-login claude|codex|grok|kimi <account-id>
//
// The provider tools are the versions Distill runs on Windows: the managed
// bridges from acp-tools.lock.json (installed with npm ci from the same
// lock) and the pinned Kimi Code and Grok releases.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DISTRO = "distill-bench";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resources = path.join(
  repo,
  "src-tauri",
  "resources",
  "benchmark-sandbox",
);
const root = process.env.DISTILL_ROOT || path.join(os.homedir(), ".distill");
const location = path.join(root, "benchmarks", "sandbox");
// Versions pinned by the native benchmark policies.
const SPECS = {
  kimi: "@moonshot-ai/kimi-code@2.1.0",
  grok: "@xai-official/grok@1.0.40",
};
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
    fs.copyFileSync(path.join(resources, file), path.join(dir, file));
  }
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

function provision() {
  if (!distroExists()) create();
  const dir = stage();
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
          "tar -x -C /tmp/distill-provision && bash /tmp/distill-provision/provision.sh",
      ],
      { input: tar.stdout, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (result.status !== 0)
      throw new Error(`provision.sh exited ${result.status}`);
    // The boot configuration (no Windows drives, no interop) applies from the next start.
    wsl(["--terminate", DISTRO]);
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

function selftest() {
  const script = fs.readFileSync(path.join(resources, "selftest.sh"));
  const result = wsl(["-d", DISTRO, "-u", "root", "--exec", "bash", "-s"], {
    input: script,
    stdio: ["pipe", "inherit", "inherit"],
  });
  process.exitCode = result.status ?? 1;
}

const [command] = process.argv.slice(2);
if (!command) provision();
else if (command === "status") status();
else if (command === "selftest") selftest();
else throw new Error(`unknown command ${command}`);
