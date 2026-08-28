import { describe, expect, it } from "vitest";

import {
  breachedBudgets,
  describeBreach,
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
  it("has no opinion without a budget", () => {
    expect(firstBreachedLimit(undefined, { usd: 99 })).toBeNull();
  });

  it("reports the money first when two ceilings went at once", () => {
    // The operator's next decision is about the money, so the notice should
    // be about the money.
    const breach = firstBreachedLimit(
      { usd: 1, tokens: 100 },
      { usd: 2, tokens: 500 },
    );
    expect(breach?.limit).toBe("usd");
  });

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
  it("measures the clock from when the agent was registered", () => {
    const spend = spendForNode(node({ createdAt: 0 }), undefined, 120_000);
    expect(spend.minutes).toBe(2);
    expect(spend.usd).toBeUndefined();
    expect(spend.tokens).toBeUndefined();
  });

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

  it("only stops agents that are still working", () => {
    // A finished agent that went over cost what it cost; killing it changes
    // nothing and would rewrite a terminal status.
    const nodes = {
      s1: node({ budget: { tokens: 10 }, status: "completed" }),
    };
    expect(breachedBudgets(nodes, tokens(999), 0)).toEqual([]);
  });

  it("ignores an agent with no budget at all", () => {
    expect(breachedBudgets({ s1: node() }, tokens(10 ** 9), 0)).toEqual([]);
  });

  it("names the agent, the limit and both numbers", () => {
    const nodes = { s1: node({ budget: { tokens: 100 } }) };
    expect(breachedBudgets(nodes, tokens(250), 0)).toEqual([
      { sessionId: "s1", limit: "tokens", allowed: 100, spent: 250 },
    ]);
  });

  it("does not count a node twice under an alias key", () => {
    const canonical = node({ sessionId: "s1", budget: { tokens: 1 } });
    const nodes = { s1: canonical, "client-1": canonical };
    expect(breachedBudgets(nodes, tokens(9), 0)).toHaveLength(1);
  });
});

describe("describeBreach", () => {
  it("keeps the task and appends what ran out", () => {
    const text = describeBreach(
      { sessionId: "s1", limit: "usd", allowed: 0.5, spent: 0.63 },
      "Read the docs",
    );
    expect(text).toContain("Read the docs");
    expect(text).toContain("$0.63 of $0.50");
  });
});
