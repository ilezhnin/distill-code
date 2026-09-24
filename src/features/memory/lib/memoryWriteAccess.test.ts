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

  it("refuses a session the app remembers as a wave child, node or no node", () => {
    // The graph evicts a finished wave child's node first of all, and after
    // that "no node" would read as an ordinary chat. LAWS/MEMORY.md, Writing:
    // a wave-spawned executor never writes, and is never taught the protocol.
    expect(decideMemoryWrite(undefined, granted, true)).toEqual({
      allowed: false,
      denial: "wave-child",
    });
    // Even a node that has since been re-registered as something friendlier.
    expect(
      decideMemoryWrite(node({ role: "plain-chat" }), granted, true),
    ).toEqual({ allowed: false, denial: "wave-child" });
  });
});
