import { describe, expect, it } from "vitest";

import {
  DEFAULT_SPAWNS_BY_ROLE,
  checkSpawnAllowed,
  effectiveSpawnLayers,
  formatSessionSpawnPolicyPrompt,
  formatSpawnPolicyPrompt,
} from "./spawnAcl";

describe("spawn ACL defaults", () => {
  it("lets a conductor spawn orchestrators and workers", () => {
    expect(DEFAULT_SPAWNS_BY_ROLE.conductor).toEqual([
      "orchestrator",
      "worker",
    ]);
  });

  it("lets an orchestrator spawn only workers", () => {
    expect(DEFAULT_SPAWNS_BY_ROLE.orchestrator).toEqual(["worker"]);
  });

  it("lets workers and plain chats spawn nothing", () => {
    expect(DEFAULT_SPAWNS_BY_ROLE.worker).toEqual([]);
    expect(DEFAULT_SPAWNS_BY_ROLE["plain-chat"]).toEqual([]);
  });
});

describe("effectiveSpawnLayers", () => {
  it("uses the layer default when the persona has no override", () => {
    expect(effectiveSpawnLayers("conductor")).toEqual([
      "orchestrator",
      "worker",
    ]);
    expect(effectiveSpawnLayers("worker", { spawns: undefined })).toEqual([]);
  });

  it("lets a valid persona override replace the default entirely", () => {
    expect(effectiveSpawnLayers("conductor", { spawns: [] })).toEqual([]);
    expect(effectiveSpawnLayers("worker", { spawns: ["worker"] })).toEqual([
      "worker",
    ]);
  });

  it("falls back to the default on a garbled override", () => {
    const persona = {
      spawns: ["worker", "supervisor"] as unknown as ["worker"],
    };
    expect(effectiveSpawnLayers("orchestrator", persona)).toEqual(["worker"]);
  });
});

describe("checkSpawnAllowed", () => {
  it("allows a conductor to spawn a worker by default", () => {
    expect(
      checkSpawnAllowed({ initiatorRole: "conductor", targetLayer: "worker" }),
    ).toEqual({ allowed: true });
  });

  it("refuses a worker spawning anything, naming the facts", () => {
    expect(
      checkSpawnAllowed({ initiatorRole: "worker", targetLayer: "worker" }),
    ).toEqual({
      allowed: false,
      initiatorRole: "worker",
      targetLayer: "worker",
      allowedLayers: [],
    });
  });

  it("honours a persona override that forbids a default-allowed spawn", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawns: [] },
      targetLayer: "worker",
    });
    expect(check.allowed).toBe(false);
  });

  it("honours a persona override that grants a default-forbidden spawn", () => {
    expect(
      checkSpawnAllowed({
        initiatorRole: "worker",
        initiatorPersona: { spawns: ["worker"] },
        targetLayer: "worker",
      }),
    ).toEqual({ allowed: true });
  });
});

describe("spawn policy prompt", () => {
  it("emits the exact legacy sentence when nothing may be spawned", () => {
    expect(formatSpawnPolicyPrompt([])).toBe(
      "Distill starts other agents from the Agents catalog; do not spawn chats yourself.",
    );
  });

  it("names the allowed layers when spawning is permitted", () => {
    const text = formatSpawnPolicyPrompt(["orchestrator", "worker"]);
    expect(text).toContain("orchestrator, worker");
    expect(text).toContain("refuses any other spawn");
  });

  it("gives a personaless plain chat no insert at all", () => {
    expect(formatSessionSpawnPolicyPrompt(undefined, undefined)).toBe(
      undefined,
    );
  });

  it("gives a persona chat outside the graph the prohibition line", () => {
    expect(
      formatSessionSpawnPolicyPrompt(undefined, { spawns: undefined }),
    ).toBe(
      "Distill starts other agents from the Agents catalog; do not spawn chats yourself.",
    );
  });

  it("gives a personaless wave worker the prohibition line", () => {
    expect(formatSessionSpawnPolicyPrompt("worker", undefined)).toBe(
      "Distill starts other agents from the Agents catalog; do not spawn chats yourself.",
    );
  });

  it("tells a conductor what it may start", () => {
    expect(formatSessionSpawnPolicyPrompt("conductor", undefined)).toContain(
      "orchestrator, worker",
    );
  });
});
