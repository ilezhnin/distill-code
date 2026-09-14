/**
 * Tests for the scope validation in check-i18n-strings.mjs.
 *
 * `node --test`, matching scripts/agent-driver and scripts/hooks/tests; wired
 * into `pnpm test:hooks` so `just check`/CI run it.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { resolveCheckedFiles } from "./check-i18n-strings.mjs";

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "i18n-scope-"));
  mkdirSync(join(root, "populated"), { recursive: true });
  writeFileSync(join(root, "populated", "Widget.tsx"), "export const a = 1;\n");
  writeFileSync(join(root, "populated", "notes.md"), "not checkable\n");
  mkdirSync(join(root, "empty"), { recursive: true });
  mkdirSync(join(root, "tests-only", "__tests__"), { recursive: true });
  writeFileSync(
    join(root, "tests-only", "__tests__", "Widget.test.tsx"),
    "export const a = 1;\n",
  );
  writeFileSync(join(root, "single.tsx"), "export const a = 1;\n");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveCheckedFiles", () => {
  it("returns the .ts/.tsx files under a listed directory", () => {
    assert.deepEqual(resolveCheckedFiles([join(root, "populated")]), [
      join(root, "populated", "Widget.tsx"),
    ]);
  });

  it("accepts a listed file path", () => {
    assert.deepEqual(resolveCheckedFiles([join(root, "single.tsx")]), [
      join(root, "single.tsx"),
    ]);
  });

  it("throws when a listed path does not exist", () => {
    // The regression: a renamed feature folder used to make the check pass
    // vacuously instead of failing.
    assert.throws(() => resolveCheckedFiles([join(root, "renamed")]), {
      message: /scope is stale/,
    });
    assert.throws(() => resolveCheckedFiles([join(root, "renamed")]), {
      message: /does not exist/,
    });
  });

  it("throws when a listed path yields no checkable files", () => {
    assert.throws(() => resolveCheckedFiles([join(root, "empty")]), {
      message: /no checkable \.ts\/\.tsx files/,
    });
  });

  it("throws when every file under a listed path is excluded", () => {
    assert.throws(() => resolveCheckedFiles([join(root, "tests-only")]), {
      message: /no checkable \.ts\/\.tsx files/,
    });
  });

  it("names every stale path in one error", () => {
    assert.throws(
      () =>
        resolveCheckedFiles([
          join(root, "populated"),
          join(root, "renamed"),
          join(root, "empty"),
        ]),
      (error) =>
        error.message.includes(join(root, "renamed")) &&
        error.message.includes(join(root, "empty")) &&
        !error.message.includes(join(root, "populated")),
    );
  });
});
