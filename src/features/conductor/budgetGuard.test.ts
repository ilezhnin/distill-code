import { describe, expect, it } from "vitest";

import {
  breachedBudgets,
  firstBreachedLimit,
  spendForNode,
} from "./budgetGuard";
import type { SessionNode } from "./types";

function node(over: Partial<SessionNode> = {}): SessionNode {
  return {
    sessionId: "s1",
    projectId: "p1",
    role: "worker",
    managedBy: "wave",
    parentSessionId: "c1",
    rootConductorId: "c1",
    runId: "r1",
    harnessId: "goose",
    displayName: "Bohr",
    status: "running",
    createdAt: 0,
    ...over,
  };
}

describe("firstBreachedLimit", () => {
  it("does not treat an unmeasured limit as an unspent one", () => {
    // An unpriced provider reports no cost at all. Reading that as "no money
    // was spent" would make a dollar ceiling silently useless.
    expect(firstBreachedLimit({ usd: 1 }, { tokens: 10_000 })).toBeNull();
  });

  it("stops exactly at the ceiling, not past it", () => {
    expect(firstBreachedLimit({ tokens: 100 }, { tokens: 100 })?.spent).toBe(
      100,
    );
    expect(firstBreachedLimit({ tokens: 100 }, { tokens: 99 })).toBeNull();
  });

  it("catches the run that spends nothing and burns the afternoon", () => {
    const breach = firstBreachedLimit({ minutes: 10 }, { minutes: 11 });
    expect(breach?.limit).toBe("minutes");
  });
});

describe("spendForNode", () => {
  it("takes money and tokens from the run's own accounting", () => {
    const spend = spendForNode(
      node(),
      { accumulatedTotal: 4200, accumulatedCost: 0.31 },
      0,
    );
    expect(spend).toMatchObject({ tokens: 4200, usd: 0.31 });
  });
});

describe("breachedBudgets", () => {
  const tokens = (total: number) => () => ({ accumulatedTotal: total });

  it("does not count a node twice under an alias key", () => {
    const canonical = node({ sessionId: "s1", budget: { tokens: 1 } });
    const nodes = { s1: canonical, "client-1": canonical };
    expect(breachedBudgets(nodes, tokens(9), 0)).toHaveLength(1);
  });
});
