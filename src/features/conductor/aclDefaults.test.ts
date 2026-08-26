/**
 * The default tables are UI-facing copy, so the test that matters is that
 * they still describe what the enforcement does. `decideMemoryWrite` keeps
 * its own switch (it also names WHY a refusal happened); this pins the two
 * together so the sentence under a toggle cannot drift from the rule.
 */
import { describe, expect, it } from "vitest";

import { decideMemoryWrite } from "@/features/memory/lib/memoryWriteAccess";
import { effectiveSpawnLayers } from "./spawnAcl";
import {
  ACL_ROLE_ORDER,
  DEFAULT_MEMORY_WRITE_BY_ROLE,
  DEFAULT_SPAWNS_BY_ROLE,
} from "./aclDefaults";

describe("ACL defaults", () => {
  it("covers every layer exactly once, in one canonical order", () => {
    expect([...ACL_ROLE_ORDER].sort()).toEqual(
      Object.keys(DEFAULT_SPAWNS_BY_ROLE).sort(),
    );
    expect([...ACL_ROLE_ORDER].sort()).toEqual(
      Object.keys(DEFAULT_MEMORY_WRITE_BY_ROLE).sort(),
    );
  });

  it("is the same table the spawn ACL enforces", () => {
    for (const role of ACL_ROLE_ORDER) {
      // No persona override: the effective layers ARE the default, so the
      // moved table cannot have been forked from the enforcement.
      expect(effectiveSpawnLayers(role, null)).toEqual(
        DEFAULT_SPAWNS_BY_ROLE[role],
      );
    }
  });

  it("says the same thing about memory as decideMemoryWrite", () => {
    for (const role of ACL_ROLE_ORDER) {
      const withGrant = decideMemoryWrite(
        { role, managedBy: "ui", personaId: "p" },
        () => true,
      );
      const withoutGrant = decideMemoryWrite(
        { role, managedBy: "ui", personaId: "p" },
        () => false,
      );

      switch (DEFAULT_MEMORY_WRITE_BY_ROLE[role]) {
        case "allowed":
          expect(withGrant.allowed).toBe(true);
          expect(withoutGrant.allowed).toBe(true);
          break;
        case "denied":
          expect(withGrant.allowed).toBe(false);
          expect(withoutGrant.allowed).toBe(false);
          break;
        case "grant-required":
          expect(withGrant.allowed).toBe(true);
          expect(withoutGrant.allowed).toBe(false);
          break;
      }
    }
  });
});
