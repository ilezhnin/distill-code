// Run the same pinned, local secret scanner before publication and in CI.
// Only the public scanner archive is downloaded; repository data stays local.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const version = "8.30.1";
const archives = {
  "win32-x64": [
    "windows_x64.zip",
    "d29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e",
  ],
  "linux-x64": [
    "linux_x64.tar.gz",
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  ],
  "darwin-arm64": [
    "darwin_arm64.tar.gz",
    "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
  ],
  "darwin-x64": [
    "darwin_x64.tar.gz",
    "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
  ],
};
const mode = process.argv[2];
if (!["check", "staged", "push", "history"].includes(mode)) {
  throw new Error(
    "Usage: node scripts/hooks/secret-scan.mjs <check|staged|push|history>",
  );
}

// Gitleaks can return success when Git itself cannot enumerate the repository.
// Validate that boundary independently so an empty/failed scan is not a pass.
const repository = spawnSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
});
if (repository.error || repository.status !== 0) {
  throw new Error("Secret scanning requires a readable Git worktree");
}

const scans = [];
if (mode === "push") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const commits = new Set();
  for (const line of input.trim().split(/\r?\n/).filter(Boolean)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4 || !/^[a-f0-9]{40}$/.test(fields[1])) {
      throw new Error("Invalid pre-push ref input");
    }
    if (!/^0+$/.test(fields[1])) commits.add(fields[1]);
  }
  for (const commit of commits) scans.push([`--log-opts=${commit}`]);
} else {
  if (mode !== "staged") scans.push(["--log-opts=HEAD"]);
  if (mode === "check" || mode === "staged")
    scans.push(["--pre-commit", "--staged"]);
  if (mode === "check") scans.push(["--pre-commit"]);
}
if (scans.length === 0) process.exit(0);
for (const options of scans) {
  if (!options[0].startsWith("--log-opts=")) continue;
  const revision = options[0].slice("--log-opts=".length);
  const resolved = spawnSync(
    "git",
    ["rev-parse", "--verify", `${revision}^{commit}`],
    {
      encoding: "utf8",
    },
  );
  if (resolved.error || resolved.status !== 0) {
    throw new Error("Secret scanning could not resolve the requested commit");
  }
}

const asset = archives[`${process.platform}-${process.arch}`];
if (!asset) throw new Error("No pinned Gitleaks archive for this platform");
const [suffix, checksum] = asset;
const filename = `gitleaks_${version}_${suffix}`;
const cache = join(tmpdir(), "flock-gitleaks", version);
await mkdir(cache, { recursive: true });
const archive = join(cache, filename);
let bytes;
let downloaded = false;
try {
  bytes = await readFile(archive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  console.log(`Downloading Gitleaks ${version} from its official release.`);
  const response = await fetch(
    `https://github.com/gitleaks/gitleaks/releases/download/v${version}/${filename}`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok)
    throw new Error(`Gitleaks download failed: HTTP ${response.status}`);
  bytes = Buffer.from(await response.arrayBuffer());
  downloaded = true;
}
if (createHash("sha256").update(bytes).digest("hex") !== checksum) {
  throw new Error("Gitleaks archive checksum mismatch; refusing to execute it");
}
if (downloaded) {
  const download = `${archive}.${process.pid}.tmp`;
  await writeFile(download, bytes);
  await rename(download, archive);
}

const scratch = await mkdtemp(join(tmpdir(), "flock-secret-scan-"));
try {
  const binaryName = process.platform === "win32" ? "gitleaks.exe" : "gitleaks";
  // Git for Windows also ships GNU tar, which treats C: as a remote host and
  // cannot unpack ZIPs. Use Windows' native bsdtar regardless of hook PATH.
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot, "System32", "tar.exe")
      : "tar";
  const extraction = spawnSync(
    tar,
    ["-xf", archive, "-C", scratch, binaryName],
    { stdio: "inherit" },
  );
  if (extraction.error) throw extraction.error;
  if (extraction.status !== 0)
    throw new Error("Could not extract the verified Gitleaks archive");
  const binary = join(scratch, binaryName);
  await chmod(binary, 0o700);
  for (const options of scans) {
    const report = join(scratch, "report.json");
    const result = spawnSync(
      binary,
      [
        "git",
        ...options,
        "--redact=100",
        "--no-banner",
        "--no-color",
        "--ignore-gitleaks-allow",
        "--config",
        join(root, ".gitleaks.toml"),
        "--gitleaks-ignore-path",
        join(root, ".gitleaksignore"),
        "--report-format=json",
        "--report-path",
        report,
        "--timeout=120",
      ],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      // Never print source excerpts or matched values, even for test fixtures.
      if (result.status === 1) {
        for (const finding of JSON.parse(await readFile(report, "utf8"))) {
          console.error(
            `Secret detected: ${finding.File}:${finding.StartLine} (${finding.RuleID}, commit ${finding.Commit || "staged"})`,
          );
        }
      } else {
        console.error(
          "Secret scanner could not complete. Check Git, the archive cache and scanner configuration.",
        );
      }
      process.exitCode = result.status || 1;
      break;
    }
  }
  if (!process.exitCode) console.log("Secret scan passed.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
