#!/usr/bin/env node
// Runs the transcript virtualization Playwright suite against the real
// renderer bridge. The package scripts used to set the harness variables with
// a POSIX `NAME=value command` prefix, which cmd.exe - the shell pnpm runs
// scripts in on Windows - cannot parse, so the CI lane only ever ran on the
// macOS runner and never on the platform Distill ships for.
//
// Usage: node scripts/transcript-virtualization.mjs <real|ci> [playwright args]

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const SUITE_DIR = "tests/transcript-virtualization";
const SPECS = {
  real: ["transcript-parity.spec.ts", "transcript-resize-anchoring.spec.ts"],
  ci: [
    "transcript-parity.spec.ts",
    "transcript-resize-anchoring.spec.ts",
    "transcript-product-contract.spec.ts",
  ],
};

const [mode, ...extraArgs] = process.argv.slice(2);
if (!Object.hasOwn(SPECS, mode ?? "")) {
  console.error(
    "usage: node scripts/transcript-virtualization.mjs <real|ci> [args...]",
  );
  process.exit(2);
}

const playwrightCli = createRequire(import.meta.url).resolve(
  "@playwright/test/cli",
);
const result = spawnSync(
  process.execPath,
  [
    playwrightCli,
    "test",
    "--config",
    `${SUITE_DIR}/playwright.config.ts`,
    "--project=desktop",
    ...SPECS[mode].map((spec) => `${SUITE_DIR}/${spec}`),
    ...extraArgs,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      TRANSCRIPT_VIRTUALIZATION_START_SERVER: "1",
      TRANSCRIPT_VIRTUALIZATION_RENDERER_URL:
        "http://127.0.0.1:1520/tests/transcript-virtualization/real-renderer-bridge.html",
      TRANSCRIPT_VIRTUALIZATION_RENDERERS: "virtual",
    },
  },
);

if (result.error) {
  console.error(`transcript-virtualization: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
