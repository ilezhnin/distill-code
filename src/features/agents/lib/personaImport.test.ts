import { describe, expect, it } from "vitest";
import { i18n } from "@/shared/i18n";
import {
  findAgentNameClash,
  foreignSourceKind,
  formatImportSuccessMessage,
  MAX_PERSONA_IMPORT_BYTES,
  validatePersonaImportFile,
} from "./personaImport";

describe("validatePersonaImportFile", () => {
  it("rejects persona imports larger than the configured cap", () => {
    expect(
      validatePersonaImportFile({
        name: "scout.agent.json",
        type: "application/json",
        size: MAX_PERSONA_IMPORT_BYTES + 1,
      }),
    ).toEqual({
      key: "view.importTooLarge",
      options: { maxSize: "4 MB" },
    });
  });
});

describe("foreignSourceKind", () => {
  it("names a skill or a project the app exported", () => {
    const skill = JSON.stringify({
      version: 1,
      type: "skill",
      name: "release-notes",
      description: "Writes notes",
      content: "Do it.",
    });
    expect(foreignSourceKind(skill, "release-notes.skill.json")).toBe("skill");
    expect(
      foreignSourceKind(
        JSON.stringify({ version: 1, type: "project", name: "p1" }),
        "p1.project.json",
      ),
    ).toBe("project");
    // Dressed as a legacy persona, it is still what it says it is.
    expect(
      foreignSourceKind(
        JSON.stringify({
          version: 1,
          type: "skill",
          displayName: "Reviewer",
          systemPrompt: "MARKER-PERSONA",
        }),
        "reviewer.json",
      ),
    ).toBe("skill");
  });

  it("leaves agent files to the import itself", () => {
    for (const [contents, name] of [
      [JSON.stringify({ version: 1, type: "agent", name: "Scout" }), "a.json"],
      [JSON.stringify({ version: 1, displayName: "Scout" }), "a.json"],
      ["not json", "a.json"],
      ["null", "a.json"],
      ["---\ntype: skill\nname: scout\n---\n\nBody", "scout.persona.md"],
    ]) {
      expect(foreignSourceKind(contents, name)).toBeNull();
    }
  });
});

describe("findAgentNameClash", () => {
  const reviewer = {
    path: "C:\\Example\\.flock\\agents\\reviewer.md",
    name: "Reviewer",
  };
  const acceptance = {
    path: "C:/Example/.flock/agents/gate.md",
    name: "Acceptance Check",
    properties: { metadata: { flockBundledSource: "acceptor" } },
  };
  const draft = {
    path: "C:/Example/.flock/agents/draft-7.md",
    name: "Scout",
    properties: { draft: true },
  };
  const agents = [reviewer, acceptance, draft];

  it("finds the agent that already answers to the name", () => {
    for (const [name, taken] of [
      ["Reviewer", reviewer],
      ["reviewer", reviewer],
      ["  REVIEWER ", reviewer],
      ["Re\u200bviewer", reviewer],
      ["Acceptance_Check", acceptance],
      ["acceptance  check", acceptance],
      // The name of its file, and the bundled agent it was made from.
      ["gate", acceptance],
      ["Acceptor", acceptance],
      // A builder draft the Agents list does not show.
      ["scout", draft],
    ] as const) {
      expect(findAgentNameClash(name, agents), name).toBe(taken);
    }
  });

  it("lets a name nobody has through", () => {
    for (const name of ["Reviewer of docs", "Rev", "Scout 2", "Ревьюер", ""]) {
      expect(findAgentNameClash(name, agents), name).toBeUndefined();
    }
    expect(findAgentNameClash("Reviewer", [])).toBeUndefined();
  });
});

describe("formatImportSuccessMessage", () => {
  it("says what was imported, in both languages", async () => {
    const one = formatImportSuccessMessage([{ displayName: "Scout" }]);
    const two = formatImportSuccessMessage([
      { displayName: "Scout" },
      { displayName: "Reviewer" },
    ]);
    expect(i18n.t(one.key, { ns: "agents", ...one.options })).toBe(
      'Imported agent "Scout".',
    );
    expect(i18n.t(two.key, { ns: "agents", ...two.options })).toBe(
      "Imported 2 agents: Scout, Reviewer.",
    );

    await i18n.changeLanguage("es");
    expect(i18n.t(one.key, { ns: "agents", ...one.options })).toBe(
      'Se importó el agente "Scout".',
    );
    expect(i18n.t(two.key, { ns: "agents", ...two.options })).toBe(
      "Se importaron 2 agentes: Scout, Reviewer.",
    );
  });

  it("has the refusals in both languages", async () => {
    const said = new Set<string>();
    for (const locale of ["en", "es"]) {
      await i18n.changeLanguage(locale);
      for (const key of [
        "view.importOtherKind.skill",
        "view.importOtherKind.project",
        "view.importNameTaken",
        "imageImport.added",
      ]) {
        const text = i18n.t(key, {
          ns: "agents",
          name: "Scout",
          existing: "scout",
        });
        expect(text).not.toBe(key);
        expect(text).not.toContain("{{");
        said.add(text);
      }
    }
    expect(said.size).toBe(8);
    await i18n.changeLanguage("en");
    expect(i18n.t("view.importOtherKind.skill", { ns: "agents" })).toBe(
      "This file holds a skill, not an agent. Import it from Skills.",
    );
    expect(
      i18n.t("view.importNameTaken", {
        ns: "agents",
        name: "reviewer",
        existing: "Reviewer",
      }),
    ).toBe(
      'The name "reviewer" is already taken by the agent "Reviewer". Rename or remove that agent, or change the name in the file.',
    );
  });
});
