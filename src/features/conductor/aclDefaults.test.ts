import { expect, it } from "vitest";
import { decideMemoryWrite } from "@/features/memory/lib/memoryWriteAccess";
import { ACL_ROLE_ORDER, DEFAULT_MEMORY_WRITE_BY_ROLE } from "./aclDefaults";

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
