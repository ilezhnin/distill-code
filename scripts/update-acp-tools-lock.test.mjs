/**
 * Tests for the Node-version gate in update-acp-tools-lock.mjs.
 *
 * `node --test`, matching scripts/agent-driver and scripts/hooks/tests: this
 * script has no wired-in check today (it is a manual, network-touching
 * maintenance tool — see AGENTS.md/README on refreshing acp-tools.lock.json),
 * so this file is not invoked by `just check` or `pnpm test`; run it
 * directly with `node --test scripts/update-acp-tools-lock.test.mjs`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPinnedNodeVersion } from "./update-acp-tools-lock.mjs";

describe("checkPinnedNodeVersion", () => {
  it("passes silently on an exact match", () => {
    let warned = false;
    checkPinnedNodeVersion("v24.11.0", "v24.11.0", () => {
      warned = true;
    });
    assert.equal(warned, false);
  });

  it("warns but continues on a same-major patch mismatch", () => {
    // The regression case: fnm/Hermit provision 24.10.0, the lock pins
    // 24.11.0 — both are Node 24, and npm's lockfile format (what the
    // check actually protects) does not change between Node patches.
    let message = null;
    checkPinnedNodeVersion("v24.10.0", "v24.11.0", (m) => {
      message = m;
    });
    assert.match(message, /warning/);
    assert.match(message, /v24\.10\.0/);
    assert.match(message, /v24\.11\.0/);
  });

  it("throws on a different major version", () => {
    assert.throws(
      () => checkPinnedNodeVersion("v22.9.0", "v24.11.0", () => {}),
      /Node 24\.x/,
    );
  });
});
