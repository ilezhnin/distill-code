import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ExecutorDecision } from "@/features/benchmarks/lib/executorSelection";
import { ChatExecutorHint } from "../ChatExecutorHint";

afterEach(cleanup);

function decision(learnedStatus: string): ExecutorDecision {
  return {
    source: "prior",
    reason: "persona_prior",
    learnedStatus,
    chosen: {
      id: "invented-row",
      providerId: "codex-acp",
      accountId: "invented-account",
      modelId: "invented-model",
      modelName: "Invented model",
      effort: null,
      fastMode: null,
      billingMode: "simulated",
      executionProfile: "native_text",
      inventoryRevision: "invented-revision",
    },
    request: { prediction: { task: { workClassId: "debug" } } },
  } as unknown as ExecutorDecision;
}

it("says why an ordinary chat keeps its preferences instead of learned routing", async () => {
  render(
    <ChatExecutorHint
      open
      read={async () => decision("ordinary_context_uncovered")}
    />,
  );
  expect(
    await screen.findByText(/Learned routing applies only to bounded tasks/),
  ).toBeVisible();
  expect(screen.getByText(/Suggested from preferences/)).toBeVisible();
});

it("adds no ordinary-context note to other decisions", async () => {
  render(
    <ChatExecutorHint open read={async () => decision("not_requested")} />,
  );
  expect(await screen.findByText(/Suggested from preferences/)).toBeVisible();
  expect(
    screen.queryByText(/Learned routing applies only to bounded tasks/),
  ).toBeNull();
});
