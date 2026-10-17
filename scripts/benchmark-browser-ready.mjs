import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

// Finalize explicitly installed pins with a real protected Chromium launch.
// No package installation, provider sign-in, model call or private task occurs.
if (process.argv.includes("--help")) {
  console.log("node scripts/benchmark-browser-ready.mjs");
  console.log(
    "Verify installed Linux browser pins and sandboxed interaction before issuing readiness.",
  );
  process.exit(0);
}
if (process.platform !== "win32")
  throw new Error("Browser readiness needs fresh native Windows headroom");

const wsl = ["-d", "distill-bench", "-u", "root", "--exec"];
const id = `browser-ready-${randomUUID()}`;
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => abort.abort());
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

function control(args) {
  return spawnSync("wsl.exe", [...wsl, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 65536,
  });
}
async function reserve() {
  const until = Date.now() + 300000;
  while (Date.now() < until) {
    abort.signal.throwIfAborted();
    const sampled = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", headroom],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4096,
      },
    );
    if (
      sampled.status !== 0 ||
      !/^\d+,\d+,\d+,\d+$/u.test(sampled.stdout.trim())
    )
      throw new Error("Native Windows headroom sampling failed");
    const reserved = control([
      "/usr/local/sbin/bench-budget",
      "reserve",
      "browser",
      id,
      String(Date.now() + 90000),
      sampled.stdout.trim(),
      String(8 * 1024 * 1024 + 128 * 1024),
    ]);
    if (reserved.status === 0) {
      const result = JSON.parse(reserved.stdout);
      if (
        result.id !== id ||
        result.class !== "browser" ||
        !/^[0-9a-f]{32}$/u.test(result.token)
      )
        throw new Error("Browser reservation acknowledgement is invalid");
      return result.token;
    }
    if (!reserved.stderr.includes("resource_busy:"))
      throw new Error("Browser reservation failed before any worker started");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Browser capacity remained busy before any worker started");
}
async function prove(token) {
  const child = spawn(
    "wsl.exe",
    [
      ...wsl,
      "/usr/bin/env",
      `DISTILL_BENCH_RESERVATION=${token}`,
      "/usr/local/sbin/bench-browser",
      "provision-receipt",
      id,
    ],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal: abort.signal,
    },
  );
  let stdout = "",
    stderr = "";
  const append = (current, chunk, cap) => {
    if (Buffer.byteLength(current) + chunk.length > cap) {
      abort.abort();
      throw new Error("Browser readiness output exceeded its cap");
    }
    return current + chunk;
  };
  let overflow;
  child.stdout.on("data", (chunk) => {
    try {
      stdout = append(stdout, chunk, 8192);
    } catch (error) {
      overflow = error;
    }
  });
  child.stderr.on("data", (chunk) => {
    try {
      stderr = append(stderr, chunk, 65536);
    } catch (error) {
      overflow = error;
    }
  });
  const timer = setTimeout(() => abort.abort(), 90000);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (overflow) throw overflow;
    if (code !== 0)
      throw new Error(
        "Sandboxed Chromium readiness proof failed; no receipt issued",
      );
    const status = JSON.parse(stdout);
    if (
      ![status.revision, status.expectedRevision].every(
        (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value),
      )
    )
      throw new Error("Browser readiness identity is invalid");
    console.log(JSON.stringify(status));
    if (stderr.trim()) console.error(stderr.trim());
  } finally {
    clearTimeout(timer);
  }
}
let token;
try {
  token = await reserve();
  await prove(token);
} finally {
  control(["/usr/local/sbin/bench-clean", id]);
  if (token) control(["/usr/local/sbin/bench-budget", "release", token]);
}
