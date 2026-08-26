/**
 * The memory ACL's layer rule, tested where it is pure.
 *
 * The property that matters most is the default: a session the graph knows
 * nothing about is an ordinary operator chat and must keep writing — the
 * manual checklist's C-scenarios depend on it.
 */
import { describe, expect, it } from "vitest";

import type { SessionNode } from "@/features/conductor/types";

import { decideMemoryWrite } from "./memoryWriteAccess";

const granted = (personaId: string | undefined) => personaId === "p-granted";

type NodeFacts = Pick<SessionNode, "role" | "managedBy" | "personaId">;

function node(over: Partial<NodeFacts> = {}): NodeFacts {
  return { role: "worker", managedBy: "ui", ...over };
}

describe("decideMemoryWrite", () => {
  it("lets an ordinary chat write — no graph node means no restriction", () => {
    expect(decideMemoryWrite(undefined, granted)).toEqual({ allowed: true });
  });

  it("lets the conductor write", () => {
    expect(decideMemoryWrite(node({ role: "conductor" }), granted)).toEqual({
      allowed: true,
    });
  });

  it("treats a plain-chat node as the operator's own conversation", () => {
    expect(decideMemoryWrite(node({ role: "plain-chat" }), granted)).toEqual({
      allowed: true,
    });
  });

  it("refuses a wave child regardless of its role", () => {
    expect(
      decideMemoryWrite(
        node({
          role: "orchestrator",
          managedBy: "wave",
          personaId: "p-granted",
        }),
        granted,
      ),
    ).toEqual({ allowed: false, denial: "wave-child" });
  });

  it("refuses a worker-layer node outside the wave engine too", () => {
    expect(
      decideMemoryWrite(node({ managedBy: "agent-cli" }), granted),
    ).toEqual({ allowed: false, denial: "worker" });
  });

  it("lets an orchestrator write only with the persona grant", () => {
    expect(
      decideMemoryWrite(
        node({ role: "orchestrator", personaId: "p-granted" }),
        granted,
      ),
    ).toEqual({ allowed: true });
    expect(
      decideMemoryWrite(
        node({ role: "orchestrator", personaId: "p-plain" }),
        granted,
      ),
    ).toEqual({ allowed: false, denial: "orchestrator-without-grant" });
    // No persona at all is no grant.
    expect(decideMemoryWrite(node({ role: "orchestrator" }), granted)).toEqual({
      allowed: false,
      denial: "orchestrator-without-grant",
    });
  });
});
