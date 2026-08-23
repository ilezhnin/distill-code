import { describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  fileStemFromPersonaId,
  resolveDefaultConductorPersona,
  resolvePersonaForRole,
} from "./roleCatalog";

function persona(id: string, displayName: string): Persona {
  return {
    id: `/agents/${id}.md`,
    displayName,
    systemPrompt: "prompt",
    isBuiltin: true,
    writable: false,
    sourceProperties: {
      metadata: { berdBundled: true, berdBundledSource: id },
    },
  };
}

const personas = [
  persona("producer", "Producer"),
  persona("planner", "Planner"),
  persona("brigade", "Brigade"),
  persona("scout", "Scout"),
  persona("qa", "QA"),
];

describe("resolvePersonaForRole", () => {
  it("matches bundled source, then file stem", () => {
    expect(resolvePersonaForRole("planner", personas)?.displayName).toBe(
      "Planner",
    );
    expect(fileStemFromPersonaId("/tmp/brigade.md")).toBe("brigade");
  });
});

describe("resolveDefaultConductorPersona", () => {
  it("prefers producer", () => {
    expect(resolveDefaultConductorPersona(personas)?.displayName).toBe(
      "Producer",
    );
  });
});
