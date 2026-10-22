import { describe, expect, it } from "vitest";
import { BUNDLED_SOURCE_METADATA_KEYS } from "@/shared/lib/agentSpawns";
import type { Persona } from "@/shared/types/agents";
import {
  resolveDefaultConductorPersona,
  resolvePersonaForRole,
} from "./roleCatalog";

function persona(
  id: string,
  displayName: string,
  metadata?: Record<string, unknown>,
): Persona {
  return {
    id,
    displayName,
    systemPrompt: "",
    isBuiltin: false,
    writable: true,
    sourceProperties: metadata ? { metadata } : undefined,
  };
}

describe("resolvePersonaForRole", () => {
  it("resolves a role through the bundled source an earlier build wrote", () => {
    // A seeded agent file renamed by the user keeps the role it was made
    // from in its metadata. That attribution was written under the app's
    // earlier names too, and a copy the startup rewrite has not reached
    // still carries it that way.
    for (const key of BUNDLED_SOURCE_METADATA_KEYS) {
      const personas = [
        persona("/x/.distill/agents/gatekeeper.md", "Gatekeeper", {
          [key]: "acceptor",
        }),
        persona("/x/.distill/agents/reviewer.md", "Reviewer"),
      ];

      expect(resolvePersonaForRole("acceptor", personas)?.id).toBe(
        "/x/.distill/agents/gatekeeper.md",
      );
    }
  });

  it("prefers the bundled source over a file stem of the same name", () => {
    const personas = [
      persona("/x/.distill/agents/acceptor.md", "Acceptor copy"),
      persona("/x/.distill/agents/gatekeeper.md", "Gatekeeper", {
        [BUNDLED_SOURCE_METADATA_KEYS[1]]: "acceptor",
      }),
    ];

    expect(resolvePersonaForRole("acceptor", personas)?.id).toBe(
      "/x/.distill/agents/gatekeeper.md",
    );
  });

  it("falls back to the file stem, then the display name", () => {
    const personas = [
      persona("/x/.distill/agents/planner.md", "Plan Writer"),
      persona("/x/.distill/agents/other.md", "Producer"),
    ];

    expect(resolvePersonaForRole("planner", personas)?.displayName).toBe(
      "Plan Writer",
    );
    expect(resolvePersonaForRole("producer", personas)?.id).toBe(
      "/x/.distill/agents/other.md",
    );
    expect(resolvePersonaForRole("", personas)).toBeUndefined();
  });
});

describe("resolveDefaultConductorPersona", () => {
  it("falls back to any persona attributed to a bundled agent by an earlier build", () => {
    const personas = [
      persona("/x/.distill/agents/mine.md", "Mine"),
      persona("/x/.distill/agents/scout.md", "Scout", {
        [BUNDLED_SOURCE_METADATA_KEYS[2]]: "scout",
      }),
    ];

    expect(resolveDefaultConductorPersona(personas)?.id).toBe(
      "/x/.distill/agents/scout.md",
    );
  });
});
