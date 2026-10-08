// Local safeguards for private project and evaluation material. This is not a semantic
// confidentiality proof; the repository rules still require content review.
import { execFileSync } from "node:child_process";

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  });
}

// The pre-push history guard is scripts/hooks/private-history-guard.sh: plain
// sh, so it also runs where a GUI client starts hooks without Node.
const mode = process.argv[2];
if (mode !== "--staged") {
  throw new Error("Expected --staged");
}

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
    /(^|\/)benchmarks\/exports\//i.test(path) ||
    /(^|\/)(?:\.distill|\.codex|\.claude|private|privacy-cleanup-[^/]+)(\/|$)/i.test(
      path,
    ) ||
    /^(?:\.agents\/(?:skills|plans)|distro\/agents)\//i.test(path) ||
    (/^distro\/skills\//i.test(path) &&
      !/^distro\/skills\/(?:distill-help|distill-monitor)\//i.test(path)) ||
    /(^|\/)(?:prompt|user|lore|security-posture)\.md$/i.test(path) ||
    /(^|\/)(?:memory\.json|IMPLEMENTATION_PLAN\.md)$/i.test(path) ||
    /^(?:research\/|handoff[^/]*\.md$)/i.test(path) ||
    /\.(?:bundle|db|sqlite3?)$/i.test(path) ||
    /^docs\/(?:.*-plan|.*roadmap.*|audit-.*|.*-audit-and-migration|composable-capabilities|work-status-.*)\.md$/i.test(
      path,
    ) ||
    /^LAWS\/PROPOSAL-.*\.md$/i.test(path) ||
    /(?:\.private\.|\.(?:pem|key)$)/i.test(path) ||
    (/(^|\/)\.env(?:\.|$)/i.test(path) && !/\.env\.example$/i.test(path))
  ) {
    console.error(`Private data path must stay outside Git: ${path}`);
    rejected = true;
    continue;
  }
  const staged = git(["show", `:${path}`]);
  if (staged.includes("\0")) continue;
  if (
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]{16,}?-----END (?:[A-Z]+ )?PRIVATE KEY-----/.test(
      staged,
    ) ||
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,}|sk-(?:proj-)?[A-Za-z0-9_-]{48,}|AKIA[A-Z0-9]{16})\b/.test(
      staged,
    )
  ) {
    console.error(`Credential-shaped content in staged file: ${path}`);
    rejected = true;
  }
  if (!/\.(md|mdx|rst|txt)$/i.test(path)) continue;
  if (
    /(?:benchmark-review-qa|benchmark-tools|drafts-hard|drafts-repository)[/\\][^\s`]+/i.test(
      staged,
    )
  ) {
    // Do not print a matching passage: hook/CI output may itself be shared.
    console.error(`Private artifact reference in staged document: ${path}`);
    rejected = true;
  }
}
if (rejected) process.exit(1);
