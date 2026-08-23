import { describe, expect, it } from "vitest";
import {
  isRoleInLayer,
  isWorkerLayerRole,
  normalizeRoleId,
  resolveRoleInLayer,
  roleDisplayName,
  roleIdsForLayer,
  workerLayerRoleIds,
} from "./roleLayers";

describe("roleLayers", () => {
  it("normalizes a role id written by a model", () => {
    expect(normalizeRoleId("  QA \n")).toBe("qa");
  });

  it("resolves a worker-layer role to its catalog entry", () => {
    const check = resolveRoleInLayer("QA", "worker");
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.role.id).toBe("qa");
      expect(check.role.displayName).toBeTruthy();
    }
  });

  it("rejects an unknown role id", () => {
    const check = resolveRoleInLayer("wizard", "worker");
    expect(check).toMatchObject({ ok: false, issue: "role-unknown" });
    if (!check.ok) expect(check.detail).toContain("wizard");
  });

  it("rejects a real role that does not carry the requested layer", () => {
    const check = resolveRoleInLayer("planner", "worker");
    expect(check).toMatchObject({ ok: false, issue: "role-wrong-layer" });
    if (!check.ok) expect(check.detail).toContain("planner");
  });

  it("accepts a dual-layer role on both of its layers", () => {
    expect(isRoleInLayer("integrator", "worker")).toBe(true);
    expect(isRoleInLayer("integrator", "orchestrator")).toBe(true);
    expect(isRoleInLayer("integrator", "conductor")).toBe(false);
  });

  it("exposes worker-layer role ids and excludes planning roles", () => {
    const ids = workerLayerRoleIds();
    expect(ids).toContain("brigade");
    expect(ids).toContain("researcher");
    expect(ids).not.toContain("planner");
    expect(ids).not.toContain("producer");
    expect(ids).toEqual(roleIdsForLayer("worker"));
  });

  it("answers the worker-layer shorthand", () => {
    expect(isWorkerLayerRole("writer")).toBe(true);
    expect(isWorkerLayerRole("producer")).toBe(false);
  });

  it("falls back to the raw id for an unknown display name", () => {
    expect(roleDisplayName("qa")).not.toBe("qa");
    expect(roleDisplayName("wizard")).toBe("wizard");
  });
});
