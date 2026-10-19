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
# The fifth field is the host CPU share in thousandths; 1001 = not sampled.
Write-Output ([string]::Join(',',@([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(),$memory.Available,$commit,$available,1001)))
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
  if (
    result.status !== 0 ||
    !/^\d+,\d+,\d+,\d+,\d+$/.test(result.stdout.trim())
  )
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
  const reserve = (kind, owner = id) => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const reply = call("/usr/local/sbin/bench-budget", [
        "reserve",
        kind,
        owner,
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
  // A helper under its own lease, answering whatever its exit status.
  const leased = (program, args, kind, input, owner = id) => {
    const token = reserve(kind, owner);
    const result = call(
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
  const work = (program, args, kind, input, owner = id) => {
    const result = leased(program, args, kind, input, owner);
    if (result.status !== 0)
      throw new Error(`${program}: ${result.stderr.trim()}`);
    return result.stdout;
  };
  try {
    // A freshly started distribution may still be running its boot command;
    // bring the network and the scratch volume up first, as bench-run does.
    successful("/usr/local/sbin/bench-net");
    const status = successful("/usr/local/sbin/bench-budget", ["status"]);
    // Rust readiness pins the dynamic policy and its fixed aggregate.
    pass(
      "aggregate limits, per-job IO and hard scratch",
      /^budget heavy-cap (off|[1-8])$/m.test(status) &&
        [
          "budget admission measured-load-v1",
          "budget memory 25769803776",
          "budget cpu 1500000/100000",
          "budget pids 4224",
          "budget io 1073741824/268435456",
          "budget swap 0",
          "budget disk dynamic 8589934592",
          "budget inodes dynamic 131072",
          "budget job-io heavy 134217728/33554432 prep 134217728/33554432 light 33554432/8388608",
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
    // Snapshot cache: an archive is kept only once it holds its tree, a copy
    // or a check from it is that snapshot, and no run ever sees the cache.
    const snapshot = tar([["file.txt", "one\n"]]);
    const tree = root(
      `import subprocess;print(subprocess.check_output(['git','--git-dir=/srv/bench/base/${id}/.git','rev-parse','HEAD^{tree}'],text=True).strip())`,
    );
    const fake = "7".repeat(40);
    const entry = (name) => `/srv/bench/cache/${name}.tar`;
    const owned = (suffix) => `${id}-${suffix}`;
    const exists = (path) =>
      root(`import os;print(os.path.lexists('${path}'))`) === "True";
    const leftover = (suffix) =>
      root(
        `import os;print(sum(os.path.lexists('/srv/bench/'+d+'/${owned(suffix)}') for d in ('work','base','checks','staging')))`,
      ) !== "0";
    const copy = (suffix, name, input) =>
      leased(
        "/usr/local/sbin/bench-copy",
        [
          owned(suffix),
          String(Date.now() + 60_000),
          name,
          ...(input ? ["-"] : []),
        ],
        "prep",
        input,
        owned(suffix),
      );
    const plant = (age) =>
      root(
        `import os,shutil,time;shutil.copyfile('${entry(tree)}','${entry(fake)}');os.chmod('${entry(fake)}',0o400);t=time.time()-${age};os.utime('${entry(fake)}',(t,t))`,
      );
    const scrub = () =>
      root(
        `import pathlib;[pathlib.Path(p).unlink(missing_ok=True) for p in ('${entry(tree)}','${entry(fake)}')]`,
      );
    const suffixes = [
      "miss",
      "wrong",
      "stored",
      "hit",
      "damaged",
      "evict",
      "check-miss",
      "check-wrong",
    ];
    scrub();
    try {
      const miss = copy("miss", tree);
      pass(
        "an uncached snapshot is a miss that writes nothing",
        miss.status === 3 &&
          miss.stdout === `not cached ${tree}\n` &&
          !leftover("miss"),
      );
      const wrong = copy("wrong", fake, snapshot);
      pass(
        "an archive without its tree is refused and never kept",
        wrong.status === 70 &&
          wrong.stderr.includes("does not hold its published tree") &&
          !leftover("wrong") &&
          !exists(entry(fake)),
      );
      const stored = copy("stored", tree, snapshot);
      pass(
        "an archive holding its tree is cached, root only and read only",
        stored.status === 0 &&
          stored.stdout.split("\n").includes(`cached ${tree}`) &&
          root(
            `import os;d=os.stat('/srv/bench/cache');f=os.stat('${entry(tree)}');print(d.st_uid,oct(d.st_mode&0o777),f.st_uid,oct(f.st_mode&0o777),f.st_nlink)`,
          ) === "0 0o700 0 0o400 1",
      );
      const hit = copy("hit", tree);
      pass(
        "a cached copy holds the snapshot's tree and is the candidate's",
        hit.status === 0 &&
          root(
            `import os,subprocess;print(subprocess.check_output(['git','--git-dir=/srv/bench/base/${owned("hit")}/.git','rev-parse','HEAD^{tree}'],text=True).strip(),os.stat('/srv/bench/work/${owned("hit")}').st_uid==os.stat('/srv/bench/work/${id}').st_uid)`,
          ) === `${tree} True`,
      );
      pass(
        "a session cannot see the snapshot cache",
        work(
          "/usr/local/sbin/bench-run",
          [
            "session",
            owned("hit"),
            "DISTILL_BENCH_RESOURCE_CLASS=text",
            "--",
            "sh",
            "-c",
            // /srv/bench is a root-only tmpfs in every run: listing it is
            // refused, which shows nothing, as an empty listing would.
            `ls -A /srv/bench 2>/dev/null; cat ${entry(tree)} >/dev/null 2>&1 && echo seen; exit 0`,
          ],
          "text",
          undefined,
          owned("hit"),
        ).trim() === "",
      );
      plant(0);
      const damaged = copy("damaged", fake);
      pass(
        "a cache entry without its tree is removed, never used",
        damaged.status === 3 && !leftover("damaged") && !exists(entry(fake)),
      );
      plant(30 * 86400);
      const evicting = copy("evict", tree, snapshot);
      pass(
        "unused cache entries are evicted",
        evicting.status === 0 && !exists(entry(fake)),
      );
      const checkPackage = tar([
        ["answer.patch", patch],
        [
          "hidden/check.py",
          // os.path.exists is False where /srv/bench refuses access;
          // Path.exists would raise instead.
          `import os\nfrom pathlib import Path\nassert Path('file.txt').read_text() == 'two\\n'\nassert not os.path.exists('${entry(tree)}')\n`,
        ],
      ]);
      work(
        "/usr/local/sbin/bench-check-prep",
        [owned("hit"), tree],
        "prep",
        checkPackage,
        owned("hit"),
      );
      pass(
        "a check prepared from the cache sees the answer, not the cache",
        work(
          "/usr/local/sbin/bench-judge",
          [owned("hit"), "10", "--", "python3", "check.py"],
          "check",
          undefined,
          owned("hit"),
        ).trim() === "",
      );
      const uncached = leased(
        "/usr/local/sbin/bench-check-prep",
        [owned("check-miss"), fake],
        "prep",
        checkPackage,
        owned("check-miss"),
      );
      pass(
        "an uncached check is a miss that leaves nothing",
        uncached.status === 3 &&
          uncached.stdout === `not cached ${fake}\n` &&
          !leftover("check-miss"),
      );
      const refusedCheck = leased(
        "/usr/local/sbin/bench-check-prep",
        [owned("check-wrong"), fake],
        "prep",
        tar([
          ["answer.patch", patch],
          ["snapshot.tar", snapshot],
        ]),
        owned("check-wrong"),
      );
      pass(
        "a check from an archive without its tree is refused and leaves nothing",
        ![0, 2, 3].includes(refusedCheck.status) &&
          refusedCheck.stderr.includes("does not hold its published tree") &&
          !leftover("check-wrong"),
      );
    } finally {
      for (const suffix of suffixes)
        successful("/usr/local/sbin/bench-clean", [owned(suffix)]);
      scrub();
    }
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
    // A Claude renewal of an account with no stored sign-in refuses before
    // any session (exit 65), and only Claude renews this way (exit 64).
    pass(
      "Claude renewal needs a stored sign-in",
      call("/usr/local/sbin/bench-login", [
        "claude",
        `selftest-${randomUUID().slice(0, 8)}`,
        "--renew",
      ]).status === 65,
    );
    pass(
      "only a Claude sign-in renews",
      call("/usr/local/sbin/bench-login", ["codex", "selftest-x", "--renew"])
        .status === 64,
    );
    pass(
      "a Claude renewal deadline is Unix milliseconds",
      call("/usr/local/sbin/bench-login", [
        "claude",
        "selftest-x",
        "--renew",
        "soon",
      ]).status === 64,
    );
    // Readiness digests: a pass from the record reports exactly what a cold
    // pass reads, the record is root's alone, and a changed file is read again.
    const identity = (text) =>
      text
        .split("\n")
        .filter((line) => /^(file|binary|tool) /u.test(line))
        .join("\n");
    root(
      "import pathlib;pathlib.Path('/run/distill-bench-digests/status.json').unlink(missing_ok=True)",
    );
    const cold = identity(successful("/usr/local/sbin/bench-status"));
    const warm = identity(successful("/usr/local/sbin/bench-status"));
    pass(
      "status names the pinned node digest",
      /^binary \/usr\/local\/bin\/node [0-9a-f]{64}$/mu.test(cold),
    );
    pass(
      "recorded status digests equal a cold pass",
      cold !== "" && warm === cold,
    );
    pass(
      "digest record is root only",
      root(
        "import os;print(' '.join(f'{os.stat(p).st_uid} {os.stat(p).st_mode & 0o777:o}' for p in ('/run/distill-bench-digests', '/run/distill-bench-digests/status.json')))",
      ) === "0 700 0 600",
    );
    const probe = root(
      "import tempfile;print(tempfile.mkstemp(prefix='selftest-digest-', dir='/root')[1])",
    );
    try {
      const digest = (text) => {
        root(`import pathlib;pathlib.Path('${probe}').write_text('${text}')`);
        return successful("/usr/local/sbin/bench-digest", [
          "status",
          probe,
        ]).split(" ")[0];
      };
      const first = digest("one");
      const second = digest("two");
      pass(
        "a changed file is read again",
        first !== second &&
          second ===
            root(
              `import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('${probe}').read_bytes()).hexdigest())`,
            ),
      );
    } finally {
      root(`import pathlib;pathlib.Path('${probe}').unlink(missing_ok=True)`);
    }
    // Host evidence has five fields: a sample with the old four is refused,
    // as an argument by bench-run and in the environment by admission.
    const four = gate().split(",").slice(0, 4).join(",");
    const asArgument = call("/usr/local/sbin/bench-run", [
      "login",
      id,
      `DISTILL_BENCH_HOST_GATE=${four}`,
      "--",
      "true",
    ]);
    pass(
      "four-field host gate refused as an argument",
      asArgument.status === 64 && asArgument.stderr.includes("five fields"),
    );
    const inEnvironment = call("/usr/bin/env", [
      `DISTILL_BENCH_HOST_GATE=${four}`,
      "/usr/local/sbin/bench-run",
      "login",
      id,
      "--",
      "true",
    ]);
    pass(
      "four-field host gate refused in the environment",
      inEnvironment.status !== 0 &&
        inEnvironment.stderr.includes("fresh Windows headroom evidence"),
    );
    // Timed jobs take the CPU before sessions: check leaves weigh 10000, a
    // session's 100.
    const weighed = `${id}-weights`;
    const weights = ["check", "text"].map((kind) => {
      const reply = call("/usr/local/sbin/bench-budget", [
        "reserve",
        kind,
        `${weighed}-${kind}`,
        String(Date.now() + 30_000),
        gate(),
      ]);
      if (reply.status !== 0) throw new Error(reply.stderr.trim());
      const token = JSON.parse(reply.stdout).token;
      tokens.push(token);
      const group = kind === "check" ? "check" : "session";
      return root(
        `from pathlib import Path;print(Path('/sys/fs/cgroup/distill-bench/${group}-${weighed}-${kind}/cpu.weight').read_text().strip())`,
      );
    });
    pass("timed jobs outweigh sessions", weights.join(" ") === "10000 100");
    // Once the sandbox is up, bench-net returns without starting a process
    // (it runs before every job and status pass).
    const forks = root(`import re,subprocess
def forks(): return int(re.search(r"processes (\\d+)", open("/proc/stat").read()).group(1))
best = None
for _ in range(3):
    before = forks(); subprocess.run(["/usr/local/sbin/bench-net"], check=True); after = forks()
    best = after - before if best is None else min(best, after - before)
print(best)`);
    pass(
      "bench-net returns at once when the sandbox is up",
      Number(forks) <= 3,
    );
    // Every finished job records what it used.
    const usage = successful("/usr/local/sbin/bench-budget", ["usage", "50"])
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    pass(
      "finished jobs record their CPU seconds and memory peak",
      usage.some(
        (entry) =>
          entry.id === id &&
          entry.kind === "text" &&
          typeof entry.cpuSeconds === "number" &&
          entry.memoryPeak > 0,
      ),
    );
  } finally {
    for (const token of tokens)
      successful("/usr/local/sbin/bench-budget", ["release", token]);
    successful("/usr/local/sbin/bench-clean", [id]);
  }
  process.stdout.write(
    `${checks} operator controls passed; no provider inference or real credentials used\n`,
  );
}
