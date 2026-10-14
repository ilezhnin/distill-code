// Small public operator controls. Every workload gets fresh Windows metadata
// and an atomic Linux reservation; no provider inference or real grants.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const METADATA = String.raw`
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class BenchmarkHostMetadata {
 [StructLayout(LayoutKind.Sequential)] public struct Memory {public uint Length,Load; public ulong Total,Available,TotalPage,AvailablePage,TotalVirtual,AvailableVirtual,Extended;}
 [StructLayout(LayoutKind.Sequential)] public struct Performance {public uint Size; public UIntPtr CommitTotal,CommitLimit,CommitPeak,PhysicalTotal,PhysicalAvailable,Cache,KernelTotal,KernelPaged,KernelNonpaged,PageSize; public uint Handles,Processes,Threads;}
 [DllImport("kernel32.dll")] public static extern bool GlobalMemoryStatusEx(ref Memory value);
 [DllImport("psapi.dll")] public static extern bool GetPerformanceInfo(ref Performance value,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] public static extern bool GetDiskFreeSpaceEx(string path,out ulong available,out ulong total,out ulong free);
}
'@
$memory=New-Object BenchmarkHostMetadata+Memory
$memory.Length=[Runtime.InteropServices.Marshal]::SizeOf($memory)
$performance=New-Object BenchmarkHostMetadata+Performance
$performance.Size=[Runtime.InteropServices.Marshal]::SizeOf($performance)
if(-not [BenchmarkHostMetadata]::GlobalMemoryStatusEx([ref]$memory) -or -not [BenchmarkHostMetadata]::GetPerformanceInfo([ref]$performance,$performance.Size)){throw 'Windows resource metadata unavailable'}
$distribution=Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Lxss' | ForEach-Object {Get-ItemProperty $_.PSPath} | Where-Object {$_.DistributionName -eq 'distill-bench'} | Select-Object -First 1
if(-not $distribution.BasePath){throw 'Benchmark distribution is not registered'}
[uint64]$available=0;[uint64]$total=0;[uint64]$free=0
if(-not [BenchmarkHostMetadata]::GetDiskFreeSpaceEx($distribution.BasePath,[ref]$available,[ref]$total,[ref]$free)){throw 'Sandbox volume metadata unavailable'}
$commit=($performance.CommitLimit.ToUInt64()-$performance.CommitTotal.ToUInt64())*$performance.PageSize.ToUInt64()
Write-Output ([string]::Join(',',@([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),$memory.Available,$commit,$available)))
`;

function call(program, args = [], input) {
  const result = spawnSync(
    "wsl.exe",
    ["-d", "distill-bench", "-u", "root", "--exec", program, ...args],
    {
      input,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 1 << 22,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  return result;
}

function successful(program, args = [], input) {
  const result = call(program, args, input);
  if (result.status !== 0)
    throw new Error(`${program}: ${result.stderr.trim()}`);
  return result.stdout;
}

function gate() {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", METADATA],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 65_536,
      windowsHide: true,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0 || !/^\d+,\d+,\d+,\d+$/.test(result.stdout.trim()))
    throw new Error("Windows resource metadata could not be verified");
  return result.stdout.trim();
}

function tar(entries) {
  const result = [];
  for (const [name, data] of entries) {
    const bytes = Buffer.from(data);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    result.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  result.push(Buffer.alloc(1024));
  return Buffer.concat(result);
}

export function runSelftest(resources) {
  const id = `operator-selftest-${randomUUID()}`;
  const tokens = [];
  let checks = 0;
  const pass = (name, condition) => {
    if (!condition) throw new Error(`FAIL ${name}`);
    checks++;
    process.stdout.write(`PASS ${name}\n`);
  };
  const root = (code) => successful("python3", ["-c", code]).trim();
  const reserve = (kind) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const reply = call("/usr/local/sbin/bench-budget", [
        "reserve",
        kind,
        id,
        String(deadline),
        gate(),
      ]);
      if (reply.status === 0) {
        const result = JSON.parse(reply.stdout);
        tokens.push(result.token);
        return result.token;
      }
      if (!reply.stderr.includes("resource_busy:"))
        throw new Error(reply.stderr.trim());
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    }
    throw new Error(
      "resource_busy: operator controls could not acquire a slot before their deadline",
    );
  };
  const work = (program, args, kind, input) => {
    const token = reserve(kind);
    const result = successful(
      "/usr/bin/env",
      [`DISTILL_BENCH_RESERVATION=${token}`, program, ...args],
      input,
    );
    const outcome = JSON.parse(
      successful("/usr/local/sbin/bench-budget", ["outcome", token]),
    );
    if (outcome.infrastructureError)
      throw new Error(outcome.infrastructureError);
    return result;
  };
  try {
    const status = successful("/usr/local/sbin/bench-budget", ["status"]);
    pass(
      "aggregate limits and hard scratch",
      [
        "budget memory 12884901888",
        "budget cpu 400000/100000",
        "budget swap 0",
        "budget disk 8589934592",
        "budget inodes 131072",
        "budget io 134217728/33554432",
      ].every((line) => status.includes(line)),
    );
    const outerIpc = root("import os;print(os.readlink('/proc/self/ns/ipc'))");
    work(
      "/usr/local/sbin/bench-copy",
      [id],
      "prep",
      tar([["file.txt", "one\n"]]),
    );
    const inside = JSON.parse(
      work(
        "/usr/local/sbin/bench-run",
        [
          "session",
          id,
          "DISTILL_BENCH_RESOURCE_CLASS=text",
          "--",
          "python3",
          "-c",
          `import os,json,pathlib,subprocess
p=pathlib.Path('/workspace/file.txt');p.write_text('two\\n')
print(json.dumps({'uid':os.getuid(),'rootRO':bool(os.statvfs('/').f_flag&os.ST_RDONLY),'ipc':os.readlink('/proc/self/ns/ipc'),'windows':list(pathlib.Path('/mnt').iterdir())==[],'gpu':pathlib.Path('/dev/dxg').exists(),'userns':subprocess.run(['unshare','--user','--map-root-user','true'],stderr=subprocess.DEVNULL).returncode,'tmp':os.statvfs('/tmp').f_blocks*os.statvfs('/tmp').f_frsize}))`,
        ],
        "text",
      ),
    );
    pass(
      "candidate UID, private IPC and root mount",
      inside.uid !== 0 && inside.rootRO && inside.ipc !== outerIpc,
    );
    pass("Windows drives and GPU absent", inside.windows && !inside.gpu);
    pass(
      "bounded tmpfs and usable nested user namespace",
      inside.tmp === 268435456 && inside.userns === 0,
    );
    pass(
      "outside root stays writable",
      root("import os;print(bool(os.statvfs('/').f_flag&os.ST_RDONLY))") ===
        "False",
    );
    const patch = work("/usr/local/sbin/bench-patch", [id], "prep");
    pass("protected patch capture", patch.includes("+two"));
    work(
      "/usr/local/sbin/bench-check-prep",
      [id],
      "prep",
      tar([
        ["snapshot/file.txt", "one\n"],
        ["answer.patch", patch],
        [
          "hidden/check.py",
          "from pathlib import Path\nassert Path('file.txt').read_text() == 'two\\n'\n",
        ],
      ]),
    );
    pass(
      "offline checker sees prepared artifact",
      work(
        "/usr/local/sbin/bench-judge",
        [id, "10", "--", "python3", "check.py"],
        "check",
      ).trim() === "",
    );
    const orphan = work(
      "/usr/local/sbin/bench-run",
      [
        "session",
        id,
        "DISTILL_BENCH_RESOURCE_CLASS=text",
        "--",
        "python3",
        "-c",
        "import subprocess;subprocess.Popen(['sleep','20'],start_new_session=True);print('created')",
      ],
      "text",
    );
    pass(
      "detached child ends with lease",
      orphan.trim() === "created" &&
        root(
          `from pathlib import Path;print(Path('/sys/fs/cgroup/distill-bench/session-${id}').exists())`,
        ) === "False",
    );
    // Existing invented artifact boundary tests run in reserved control memory
    // and the bounded scratch filesystem, never against real accounts/tasks.
    root(
      `from pathlib import Path;(Path('/srv/bench/staging')/'${id}').mkdir(exist_ok=True)`,
    );
    const artifactTests = fs
      .readFileSync(path.join(resources, "artifact-selftest.py"), "utf8")
      .replace(/\r\n/g, "\n");
    successful(
      "/usr/local/sbin/bench-budget",
      [
        "control",
        "--",
        "/usr/bin/env",
        `TMPDIR=/srv/bench/staging/${id}`,
        "python3",
        "-",
      ],
      artifactTests,
    );
    pass("invented artifact boundary regressions", true);
    const shellTests = fs
      .readFileSync(path.join(resources, "selftest.sh"), "utf8")
      .replace(/\r\n/g, "\n");
    const authTests = shellTests
      .split("<<'BENCH_AUTH_UNIT_TESTS'\n")[1]
      ?.split("\nBENCH_AUTH_UNIT_TESTS")[0];
    if (!authTests)
      throw new Error("Generic credential fixture suite is missing");
    successful(
      "/usr/local/sbin/bench-budget",
      [
        "control",
        "--",
        "/usr/bin/env",
        `TMPDIR=/srv/bench/staging/${id}`,
        "python3",
        "-",
        "/usr/local/sbin/bench-auth",
      ],
      authTests,
    );
    pass("invented credential merge/privacy regressions", true);
  } finally {
    for (const token of tokens)
      successful("/usr/local/sbin/bench-budget", ["release", token]);
    successful("/usr/local/sbin/bench-clean", [id]);
  }
  process.stdout.write(
    `${checks} operator controls passed; no provider inference or real credentials used\n`,
  );
}
