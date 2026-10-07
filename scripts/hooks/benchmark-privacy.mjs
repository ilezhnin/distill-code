// Local safeguards for private evaluation material. This is not a semantic
// confidentiality proof; the repository rules still require content review.
import { execFileSync } from "node:child_process";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

const mode = process.argv[2];
if (mode !== "--staged" && mode !== "--push") {
  throw new Error("Expected --staged or --push");
}

if (mode === "--push") {
  let pending = "";
  try {
    pending = git([
      "config",
      "--bool",
      "--get",
      "distill.privateBenchmarkHistoryPending",
    ]).trim();
  } catch (error) {
    // Git exits 1 when the setting is absent; malformed configuration is not
    // permission to send an unreviewed history.
    if (error.status !== 1) throw error;
  }
  if (pending === "true") {
    console.error(
      "Push refused: private benchmark material remains in Git history. Complete the authorized history review before clearing distill.privateBenchmarkHistoryPending.",
    );
    process.exit(1);
  }
} else {
  const paths = git([
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACMR",
    "-z",
  ])
    .split("\0")
    .filter(Boolean);
  let rejected = false;
  for (const path of paths) {
    if (
      /(^|\/)(benchmark-tasks|benchmark-tools|benchmark-review-qa|benchmark-private)(\/|$)/i.test(
        path,
      ) ||
      /(^|\/)benchmark-workspace-plan\.private\.md$/i.test(path) ||
      /(^|\/)benchmarks\/exports\//i.test(path)
    ) {
      console.error(
        `Private benchmark data path must stay outside Git: ${path}`,
      );
      rejected = true;
      continue;
    }
    if (!/\.(md|mdx|rst|txt)$/i.test(path)) continue;
    const staged = git(["show", `:${path}`]);
    if (
      /(?:benchmark-review-qa|benchmark-tools|drafts-hard|drafts-repository)[/\\][^\s`]+/i.test(
        staged,
      )
    ) {
      // Do not print a matching passage: hook/CI output may itself be shared.
      console.error(
        `Private benchmark artifact reference in staged document: ${path}`,
      );
      rejected = true;
    }
  }
  if (rejected) process.exit(1);
}
