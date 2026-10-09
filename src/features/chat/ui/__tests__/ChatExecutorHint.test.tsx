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

it("says why a class without a certificate keeps the preferences", async () => {
  render(
    <ChatExecutorHint
      open
      read={async () => decision("no_class_certificate")}
    />,
  );
  expect(
    await screen.findByText(/Learned selection is not active for this class/),
  ).toBeVisible();
  expect(screen.getByText(/Suggested from preferences/)).toBeVisible();
});

it("names the learned choice and an abstention", async () => {
  render(
    <ChatExecutorHint
      open
      read={async () => ({
        ...decision("certified_class_policy"),
        source: "learned",
      })}
    />,
  );
  expect(
    await screen.findByText(
      /Chosen for this task by the class's learned selector/,
    ),
  ).toBeVisible();
  cleanup();
  render(
    <ChatExecutorHint
      open
      read={async () => decision("class_policy_abstained:below_quality_floor")}
    />,
  );
  expect(
    await screen.findByText(/did not choose \(below_quality_floor\)/),
  ).toBeVisible();
});
