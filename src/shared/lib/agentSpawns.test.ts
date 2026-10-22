import { describe, expect, it } from "vitest";
import {
  BUNDLED_SOURCE_METADATA_KEYS,
  personaAgentRefs,
  readBundledSource,
} from "./agentSpawns";

describe("bundled-source metadata keys", () => {
  it("keeps the previous builds' key names beside the current one", () => {
    // The app wrote the attribution under two earlier names. A mechanical
    // rename that touched them would collapse the list into one repeated key
    // and make a role unresolvable through a file an earlier build wrote.
    expect(BUNDLED_SOURCE_METADATA_KEYS[0]).toBe("flockBundledSource");
    expect(BUNDLED_SOURCE_METADATA_KEYS).toHaveLength(3);
    expect(new Set(BUNDLED_SOURCE_METADATA_KEYS).size).toBe(
      BUNDLED_SOURCE_METADATA_KEYS.length,
    );
  });

  it("reads the source under whichever key the file carries", () => {
    for (const key of BUNDLED_SOURCE_METADATA_KEYS) {
      expect(readBundledSource({ [key]: " acceptor " })).toBe("acceptor");
      expect(readBundledSource({ [key]: "" })).toBeUndefined();
      expect(readBundledSource({ [key]: 7 })).toBeUndefined();
    }
    expect(readBundledSource(undefined)).toBeUndefined();
    expect(readBundledSource("acceptor")).toBeUndefined();
    expect(readBundledSource(["acceptor"])).toBeUndefined();
    expect(readBundledSource({})).toBeUndefined();
  });

  it("prefers the current key when a file carries more than one", () => {
    expect(
      readBundledSource({
        [BUNDLED_SOURCE_METADATA_KEYS[1]]: "planner",
        [BUNDLED_SOURCE_METADATA_KEYS[0]]: "acceptor",
      }),
    ).toBe("acceptor");
  });
});

describe("personaAgentRefs", () => {
  it("answers to the bundled source written by an earlier build", () => {
    for (const key of BUNDLED_SOURCE_METADATA_KEYS) {
      const refs = personaAgentRefs({
        id: "C:\\Users\\x\\.distill\\agents\\quality-gate.md",
        displayName: "Quality Gate",
        sourceProperties: { metadata: { [key]: "Acceptor" } },
      });
      expect(refs).toEqual(["quality-gate", "acceptor"]);
    }
  });

  it("answers to the file stem and display name without a source", () => {
    expect(
      personaAgentRefs({
        id: "/home/x/.distill/agents/release_manager.persona.md",
        displayName: "Release Manager",
        sourceProperties: { metadata: { color: "blue" } },
      }),
    ).toEqual(["release-manager"]);
  });
});
