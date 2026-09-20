import { describe, expect, it } from "vitest";

import cliSurface from "../../../../src-tauri/crates/distillctl/cli-surface.json";
import { buildCliSurfaceContract } from "@/features/distillctl/commands/contract";

/**
 * Freshness control between the renderer command registry and the distillctl
 * CLI: cli-surface.json (the CLI projection of api-surface.json) is
 * generated from TOOL_GROUPS' cli metadata and each command's
 * summary/helpFooter, and the distillctl crate builds its clap noun/verb tree
 * from the embedded file at startup. This test fails when the checked-in
 * artifact lags the registry; CI holds the same property byte-exactly with
 * `just distillctl-contract-check`.
 */
describe("distillctl CLI surface contract", () => {
  it("checked-in cli-surface.json is fresh (run `pnpm generate:distillctl-contract`)", () => {
    expect(
      JSON.parse(JSON.stringify(buildCliSurfaceContract())),
      "src-tauri/crates/distillctl/cli-surface.json is stale; run " +
        "`pnpm generate:distillctl-contract` and commit the result",
    ).toEqual(cliSurface);
  });
});
