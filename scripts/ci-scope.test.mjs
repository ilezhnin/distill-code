import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scopeForPaths } from "./ci-scope.mjs";

describe("critical CI scope", () => {
  it("does not compile native code for CSS, ordinary React or docs", () => {
    for (const path of [
      "src/shared/styles/globals.css",
      "src/app/ui/AppShellLayout.tsx",
      "package.json",
    ]) {
      assert.deepEqual(scopeForPaths([path]), {
        frontend: true,
        native: false,
      });
    }
    assert.deepEqual(scopeForPaths(["docs/help.md", "AGENTS.md"]), {
      frontend: false,
      native: false,
    });
  });
  it("checks native code for Rust, lockfiles and Windows configuration", () => {
    for (const path of [
      "src-tauri/src/lib.rs",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
    ]) {
      assert.equal(scopeForPaths([path]).native, true);
    }
    for (const path of [
      "scripts/windows/Dev-Windows.ps1",
      ".cargo/config.toml",
      "node-runtime.lock.json",
      "rust-toolchain.toml",
    ]) {
      assert.equal(scopeForPaths([path]).native, true);
    }
  });
  it("keeps both sides of command contracts and unknown changes covered", () => {
    for (const path of [
      "src/features/flockctl/commands.ts",
      "justfile",
      ".github/workflows/ci.yml",
      "new-build-config.json",
    ]) {
      assert.deepEqual(scopeForPaths([path]), { frontend: true, native: true });
    }
  });
  it("keeps native coverage when a native file moves into the frontend", () => {
    assert.deepEqual(
      scopeForPaths(["src-tauri/src/old.rs", "src/shared/new.ts"]),
      { frontend: true, native: true },
    );
  });
});
