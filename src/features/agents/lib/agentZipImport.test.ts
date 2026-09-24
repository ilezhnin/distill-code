import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { MAX_PERSONA_IMPORT_BYTES } from "./personaImport";
import {
  type AgentZipImportError,
  extractAgentFileFromZip,
} from "./agentZipImport";

describe("agent ZIP import", () => {
  it("extracts a portable agent image", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const archive = zipSync({ "reviewer.agent.png": bytes });

    expect(extractAgentFileFromZip(archive)).toEqual({
      name: "reviewer.agent.png",
      bytes,
    });
  });

  it("rejects duplicate supported paths before extraction collapses them", () => {
    const archive = zipSync({
      "one.md": new Uint8Array([1]),
      "two.md": new Uint8Array([2]),
    });
    const duplicatePathArchive = new Uint8Array(archive);
    const originalName = new TextEncoder().encode("two.md");
    const duplicateName = new TextEncoder().encode("one.md");
    for (
      let offset = 0;
      offset <= duplicatePathArchive.length - originalName.length;
      offset += 1
    ) {
      if (
        originalName.every(
          (byte, index) => duplicatePathArchive[offset + index] === byte,
        )
      ) {
        duplicatePathArchive.set(duplicateName, offset);
      }
    }

    expect(() => extractAgentFileFromZip(duplicatePathArchive)).toThrow(
      expect.objectContaining<Partial<AgentZipImportError>>({
        code: "multipleAgents",
      }),
    );
  });

  it("rejects ambiguous archives with a typed error", () => {
    const archive = zipSync({
      "one.persona.md": new Uint8Array([1]),
      "two.json": new Uint8Array([2]),
    });

    expect(() => extractAgentFileFromZip(archive)).toThrow(
      expect.objectContaining<Partial<AgentZipImportError>>({
        code: "multipleAgents",
      }),
    );
  });

  it("enforces the direct-import limit on nested text agents", () => {
    const archive = zipSync({
      "large.persona.md": new Uint8Array(MAX_PERSONA_IMPORT_BYTES + 1),
    });

    expect(() => extractAgentFileFromZip(archive)).toThrow(
      expect.objectContaining<Partial<AgentZipImportError>>({
        code: "tooLarge",
        maxBytes: MAX_PERSONA_IMPORT_BYTES,
      }),
    );
  });

  it("reports malformed archives with a typed error", () => {
    expect(() => extractAgentFileFromZip(new Uint8Array([1, 2, 3]))).toThrow(
      expect.objectContaining<Partial<AgentZipImportError>>({
        code: "invalid",
      }),
    );
  });
});
