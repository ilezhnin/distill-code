import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// The rename sweep turns every Distill spelling into its Flock spelling. The
// documentation names the old spellings on purpose where the app still reads,
// writes or adopts them for compatibility; each literal below is one of those
// sentences, and a re-run of the sweep would rewrite it into a false claim.
const repoRoot = resolve(import.meta.dirname, "../../..");

const residue = {
  "README.md": [
    "`distillctl` and `distill-monitor` still work",
    "upgraded from Distill keeps its `~/.distill`",
    "`distill-wave`",
    "`distill-recall`",
    "`_meta.distill` event metadata",
    '`"distill"` lifecycle value',
    "`.distill/` folder",
  ],
  "PRODUCT.md": [
    "project called Distill",
    "`.distill/` folder",
    "`~/.distill` folder of\nan upgraded install",
  ],
  "AGENTS.md": [
    "project named Distill",
    "`~/.distill` on installs upgraded from Distill",
    "`.distill/` directory",
    "`distill-monitor` aliases, the `DISTILL_*` variables, the `distillBundled`",
    "`distill-*` protocol fences",
  ],
  "docs/README.md": [
    "project called Distill",
    "`distill-wave`, `distill-report`, `distill-verdict`",
    "`distill-memory` and `distill-recall`",
    "`_meta.distill` and\n  `_meta.distillHistory`",
    "`distillctl_cross_session`",
    "`distillSenderLabel` and `distillDeliveryId`",
    'owner value `"distill"`',
    'client name\n  `"distill"`',
    '`"distill_accounts"`',
    "`.distill/` folder, and `~/.distill` on an install upgraded\n  from Distill",
    "`%LOCALAPPDATA%\\Distill\\monitor`",
    "`DISTILL_MONITOR_*` variables",
    "`distill-monitor-` delivery-id prefix",
    "`distill-bench`, `DISTILL_BENCH_*`",
    "`distillctl`\nand `distill-monitor` are aliases of the new CLIs",
    "`DISTILL_ROOT` and the\nother `DISTILL_*` developer variables",
    "`distill://` session links still open",
    "`distillBundled`\nmarker and the `distill-sounds-N.mp3` sound ids",
    "[Upgrading from Distill](windows-onboarding.md#upgrading-from-distill)",
  ],
  "distro/README.md": [
    "`~/.distill/skills/` on an install\nupgraded from Distill",
    "`distillBundled` and `berdBundled`",
    "retired `distill-help` and `distill-monitor` skills",
  ],
  "src-tauri/README.md": [
    "`DISTILLCTL_LOCK`, which a session of the previous build still has",
    "compatibility shims `distillctl` and `distill-monitor`",
  ],
  "docs/windows-onboarding.md": [
    "`DISTILL_TAURI_CARGO_TARGET_DIR`, the variable's earlier\nname, is still read",
    "`%LOCALAPPDATA%\\distill-dev` folder left by an earlier checkout",
    "`Levocat Flock_<version>_x64-setup.exe`",
    "## Upgrading from Distill",
    "The app was called Distill before it became Levocat Flock",
    "same\n   `~/.distill` folder with different migration sets",
    "`%APPDATA%\\com.levocat.distill`",
    "`%LOCALAPPDATA%\\com.levocat.distill`",
    "renamed once to `com.levocat.flock`",
    "`~/.distill` is adopted in place through the\n  `root-path` pointer",
    "`distillBundled` marker on installed help\n  skills becomes `flockBundled`",
    "retired `distill-help` and\n  `distill-monitor` skill copies",
    "`distill-sounds-N.mp3` notification sound ids",
    "keep their `.distill/` name",
    "`DISTILL_ROOT` is still read when it is unset",
    "`DISTILL_TAURI_CARGO_TARGET_DIR`,\n  `DISTILL_DISTRO_DIR`, `DISTILL_DEV_ROOT`, `DISTILLCTL_LOCK`,\n  `DISTILLCTL_BIN` and `DISTILL_MONITOR_BIN`",
    "replace `distillctl` and\n  `distill-monitor`; the old names remain",
    "`distill://session/<id>` still\n  open",
    "renamed from `com.levocat.distill` at first start",
  ],
  "docs/flock-root-layout.md": [
    "`DISTILL_ROOT`, the variable's earlier name, still honoured",
    "`~/.distill` when an install upgraded\nfrom Distill still has one",
    "An existing `~/.distill`\nis adopted in place",
    "project's `.distill/` folder (a name that did not change",
    "without the `distill:` prefix older builds gave browser\nkeys",
    "moved from `distill:` to `flock:`\nonce",
    "`.distill-bundled-agents.json` (and `.berd-bundled-agents.json`)",
    "`distillBundled` and `berdBundled` frontmatter markers",
    "retired\n`distill-help` and `distill-monitor` skills",
    "The `distillctl` and `distill-monitor` shims in `cache/bin/` are not retired",
    "renamed once from `com.levocat.distill` to\n`com.levocat.flock`",
    "`FLOCK_ROOT` (or `DISTILL_ROOT`) and the E2E profile skip adoption",
    "stale files in the earlier\n`distillctl/` directory",
  ],
  "docs/flockctl-architecture.md": [
    "The CLIs were `distillctl` and `distill-monitor` while the product was called\nDistill",
    "compatibility shims `distillctl.cmd` and\n  `distill-monitor.cmd`",
    "also through `DISTILLCTL_LOCK` with the same value",
    "`FLOCKCTL_LOCK`, then `DISTILLCTL_LOCK`",
    "`<app data>/distillctl/` directory are swept too",
    "`DISTILLCTL_BIN` and `DISTILL_MONITOR_BIN` are read\n  when the new spelling is unset",
    "exports `DISTILLCTL_BIN` beside\n  `FLOCKCTL_BIN`",
    "then `flockctl` or `distillctl` on\n  `PATH`",
    "`%LOCALAPPDATA%\\Distill\\monitor` on Windows",
    "`$XDG_STATE_HOME/distill/monitor` elsewhere",
    "`DISTILL_MONITOR_STATE_DIR`, `DISTILL_MONITOR_FOREGROUND` and\n  `DISTILL_MONITOR_LAUNCH_TOKEN` variables",
    "`DISTILL_MONITOR_PENDING_V1`\n  pending-file header",
    "`distill-monitor-` delivery-id prefix",
    "labelled `source: flock-monitor`",
    "`distillctl_cross_session`,\n  `distillSenderLabel` and `distillDeliveryId` keep their names",
  ],
  "docs/app-e2e.md": ["never the user's `~/.flock` or `~/.distill`"],
  "docs/model-effort-fast-selection.md": [
    "an old `distillctl` client",
    "pre-protocolVersion-6 `distillctl`",
    "`distill-memory` write protocol",
  ],
  "docs/benchmark-authoring.md": [
    "`flock.privateBenchmarkHistoryPending`",
    "`distill.*` section is still read",
    "`flock.privateBenchmarkReviewedBase`",
  ],
  "distro/skills/flock-help/SKILL.md": [
    "Flock was called Distill before",
    "`distillctl` and\n`distill-monitor` still run as aliases of `flockctl` and `flock-monitor`",
    "`~/.distill` on an install upgraded from\nDistill",
    "folder is still `.distill/`",
    "`distill-wave`, `distill-report`,\n`distill-verdict`, `distill-memory` and `distill-recall`",
  ],
  "distro/skills/flock-help/references/flockctl.md": [
    "`distillctl` is an alias of `flockctl`",
  ],
  "distro/skills/flock-help/references/settings.md": [
    "`~/.distill` on an install\nupgraded from Distill",
    "`.distill/settings.json`",
  ],
  "distro/skills/flock-help/references/skills.md": [
    "carries `distillBundled`, rewritten at startup",
    "`~/.distill/skills/` on an install upgraded from\n  Distill",
    "`<workspace>/.distill/skills`",
  ],
  "distro/skills/flock-monitor/SKILL.md": [
    "`source: flock-monitor`",
    "`distill-monitor` is an alias of `flock-monitor`",
    "still called itself Distill",
  ],
};

describe("documentation keeps the Distill names the app still reads", () => {
  for (const [file, literals] of Object.entries(residue)) {
    it(`${file} names its compatibility residue`, () => {
      const text = readFileSync(join(repoRoot, file), "utf8").replace(
        /\r\n/g,
        "\n",
      );
      for (const literal of literals) {
        assert.ok(
          text.includes(literal),
          `${file} no longer contains ${JSON.stringify(literal)}; the rename sweep must not touch this sentence`,
        );
      }
    });
  }

  it("the residue note is not the swept nonsense", () => {
    for (const file of [
      "README.md",
      "PRODUCT.md",
      "docs/README.md",
      "AGENTS.md",
    ]) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      assert.ok(
        !/project (called|named) Flock/.test(text),
        `${file} says the earlier name was Flock; it was Distill`,
      );
    }
  });
});
