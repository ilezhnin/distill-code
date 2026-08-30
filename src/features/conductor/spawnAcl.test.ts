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
      refusal: "layer",
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
  it("opens with the exact legacy sentence when nothing may be spawned", () => {
    expect(formatSpawnPolicyPrompt([])).toMatch(
      /^Distill starts other agents from the Agents catalog; do not spawn chats yourself\. /,
    );
  });

  it("names the berdctl spawn commands, enforced since P42", () => {
    // The berdctl path now carries the caller's identity and is refused in
    // code too (runtime/spawnGate.ts); the prompt states the enforcement
    // because the app preamble advertises both commands.
    for (const text of [
      formatSpawnPolicyPrompt([]),
      formatSpawnPolicyPrompt(["worker"]),
    ]) {
      expect(text).toContain("`berdctl session create`");
      expect(text).toContain("`berdctl session fork`");
    }
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
    ).toBe(formatSpawnPolicyPrompt([]));
  });

  it("gives a personaless wave worker the prohibition line", () => {
    expect(formatSessionSpawnPolicyPrompt("worker", undefined)).toBe(
      formatSpawnPolicyPrompt([]),
    );
  });

  it("tells a conductor what it may start", () => {
    expect(formatSessionSpawnPolicyPrompt("conductor", undefined)).toContain(
      "orchestrator, worker",
    );
  });
});

describe("named spawn allowlist (spawns_agents)", () => {
  it("does not restrict by name when no allowlist was authored", () => {
    expect(
      checkSpawnAllowed({
        initiatorRole: "conductor",
        targetLayer: "worker",
        targetAgentRefs: ["scout"],
      }),
    ).toEqual({ allowed: true });
  });

  it("allows a named target on the list, however the author spelled it", () => {
    expect(
      checkSpawnAllowed({
        initiatorRole: "conductor",
        initiatorPersona: { spawnsAgents: ["Asset Integrator", "scout"] },
        targetLayer: "worker",
        targetAgentRefs: ["asset-integrator", "unity-asset-integrator"],
      }),
    ).toEqual({ allowed: true });
  });

  it("refuses a named target off the list, naming both sides", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawnsAgents: ["scout"] },
      targetLayer: "worker",
      targetAgentRefs: ["writer"],
      targetAgentName: "Writer",
    });
    expect(check).toEqual({
      allowed: false,
      refusal: "agent",
      initiatorRole: "conductor",
      targetLayer: "worker",
      allowedLayers: ["orchestrator", "worker"],
      allowedAgents: ["scout"],
      targetAgent: "Writer",
    });
  });

  it("refuses a spawn that names no agent once an allowlist exists", () => {
    // An allowlist of named agents with an unnamed escape hatch is not an
    // allowlist.
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawnsAgents: ["scout"] },
      targetLayer: "worker",
    });
    expect(check.allowed).toBe(false);
    expect(!check.allowed && check.refusal).toBe("agent");
  });

  it("checks the layer before the name — a layer refusal stays a layer refusal", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "worker",
      initiatorPersona: { spawnsAgents: ["scout"] },
      targetLayer: "worker",
      targetAgentRefs: ["scout"],
    });
    expect(!check.allowed && check.refusal).toBe("layer");
  });

  it("an empty allowlist refuses every named spawn", () => {
    const check = checkSpawnAllowed({
      initiatorRole: "conductor",
      initiatorPersona: { spawnsAgents: [] },
      targetLayer: "worker",
      targetAgentRefs: ["scout"],
    });
    expect(!check.allowed && check.refusal).toBe("agent");
  });
});

describe("spawn policy prompt with a named allowlist", () => {
  it("renders the menu with each agent's contract card", () => {
    const text = formatSpawnPolicyPrompt(
      ["worker"],
      [
        {
          ref: "scout",
          name: "Scout",
          whenToCall: "a factual claim needs verifying",
          requiredInput: "the claim and where it came from",
          expectedOutput: "a source-backed confirm/refute",
        },
        { ref: "mystery-agent", name: "mystery-agent" },
      ],
    );
    expect(text).toContain("only these agents, by name");
    expect(text).toContain("- Scout");
    expect(text).toContain("When to call: a factual claim needs verifying");
    expect(text).toContain(
      "The task you delegate must include: the claim and where it came from",
    );
    expect(text).toContain("It returns: a source-backed confirm/refute");
    expect(text).toContain("- mystery-agent");
  });

  it("says plainly when the named allowlist is empty", () => {
    const text = formatSpawnPolicyPrompt(["worker"], []);
    expect(text).toContain("no agents at all");
  });

  it("renders no menu when no allowlist was authored", () => {
    expect(formatSpawnPolicyPrompt(["worker"])).not.toContain("by name");
  });
});
