import { describe, expect, it } from "vitest";
import type { Persona } from "@/shared/types/agents";
import {
  DEFAULT_CONDUCTOR_ROLE_ID,
  DEFAULT_ORCHESTRATOR_ROLE_ID,
  DEFAULT_WORKER_ROLE_ID,
  fileStemFromPersonaId,
  resolveDefaultConductorPersona,
  resolvePersonaForRole,
  selectRoleForTask,
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

describe("selectRoleForTask", () => {
  it("defaults the conductor layer to producer", () => {
    const pick = selectRoleForTask("do the thing", "conductor", personas);
    expect(pick.role.id).toBe(DEFAULT_CONDUCTOR_ROLE_ID);
    expect(pick.persona?.displayName).toBe("Producer");
  });

  it("defaults the orchestrator layer to planner", () => {
    const pick = selectRoleForTask("do the thing", "orchestrator", personas);
    expect(pick.role.id).toBe(DEFAULT_ORCHESTRATOR_ROLE_ID);
  });

  it("defaults the worker layer to brigade", () => {
    const pick = selectRoleForTask("do the thing", "worker", personas);
    expect(pick.role.id).toBe(DEFAULT_WORKER_ROLE_ID);
  });

  it("picks scout for fact-checking work", () => {
    const pick = selectRoleForTask(
      "Scout and verify claims against primary sources",
      "worker",
      personas,
    );
    expect(pick.role.id).toBe("scout");
    expect(pick.persona?.displayName).toBe("Scout");
  });

  it("picks qa for a test plan", () => {
    expect(
      selectRoleForTask("Write a regression test plan", "worker").role.id,
    ).toBe("qa");
  });

  it("picks Unity Worker for MonoBehaviour and prefab work", () => {
    expect(
      selectRoleForTask(
        "Implement a MonoBehaviour on the player prefab",
        "worker",
      ).role.id,
    ).toBe("unity-worker");
  });

  it("picks Test Runner for EditMode validation", () => {
    expect(
      selectRoleForTask("Run the EditMode tests for GameMatch", "worker").role
        .id,
    ).toBe("unity-test-runner");
  });
});

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
