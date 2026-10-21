import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

// Hooks export Git-local variables. Keep fixture repositories independent of
// the real commit, including its temporary index and worktree configuration.
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
);

if (process.platform === "win32") {
  const git = spawnSync("git", ["--exec-path"], { encoding: "utf8", env });
  if (git.error || git.status !== 0) {
    console.error(
      "Hook tests require Git for Windows.",
      git.error ?? git.stderr,
    );
    process.exit(1);
  }
  const unixBin = resolve(git.stdout.trim(), "../../../usr/bin");
  if (!existsSync(join(unixBin, "sh.exe"))) {
    console.error(
      `Git shell is missing from ${unixBin}. Repair Git for Windows.`,
    );
    process.exit(1);
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
  const inheritedPath = env[pathKey] ?? "";
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = `${unixBin}${delimiter}${inheritedPath}`;
}

const tests = readdirSync(import.meta.dirname)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(import.meta.dirname, name));
const result = spawnSync(process.execPath, ["--test", ...tests], {
  stdio: "inherit",
  env,
});
if (result.error) console.error(result.error);
process.exit(result.status ?? 1);
