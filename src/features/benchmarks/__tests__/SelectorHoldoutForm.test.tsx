import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { SelectorHoldoutForm } from "../ui/SelectorHoldoutForm";
import type { SelectorFitArtifact } from "../lib/benchmarkLearning";
import { configuration, definition } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: { message: string }) => error.message,
  benchmarkApi: {
    listSelectorHoldouts: vi.fn(async () => []),
    freezeSelectorHoldout: vi.fn(),
  },
}));
afterEach(cleanup);

it("requires independent groups and explicit baselines, then retries the same request key", async () => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  const user = userEvent.setup();
  const candidates = [
    configuration,
    { ...configuration, id: "second", modelId: "model-2" },
  ].map((configuration) => ({
    candidateKey: configuration.id,
    configuration,
    cases: 8,
    qualityCoefficients: [],
    utilityCoefficients: [],
  }));
  const artifact: SelectorFitArtifact = {
    createdAt: 1,
    model: {
      id: "fit",
      recipe: "test",
      featureVersion: "test",
      cutoffAt: 1,
      snapshotHash: "snapshot",
      workClassId: definition.draft.workClassId,
      trainingCases: 8,
      commonCases: 8,
      trainingFamilies: ["train"],
      trainingGroups: ["train"],
      candidates,
    },
    snapshot: {
      request: {
        workClassId: definition.draft.workClassId,
        versionIds: [],
        configurations: [],
        cutoffAt: 1,
        weights: { quality: 0.8, speed: 0.15, cost: 0.05 },
      },
      examples: [],
    },
  };
  const versions = Array.from({ length: 8 }, (_, index) => ({
    ...definition.versions[0],
    id: `held-${index}`,
    manifest: {
      ...definition.draft,
      name: `Held-out case ${index}`,
      taskFamily: `held-${index}`,
      split: "held_out",
      environment: { splitGroup: `held-group-${Math.floor(index / 2)}` },
    },
  }));
  vi.mocked(benchmarkApi.freezeSelectorHoldout).mockRejectedValue({
    message: "The request outcome is unavailable",
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SelectorHoldoutForm artifact={artifact} versions={versions} />
    </QueryClientProvider>,
  );
  const freeze = screen.getByRole("button", { name: "Freeze evaluation plan" });
  expect(freeze).toBeDisabled();
  for (let index = 0; index < 8; index++)
    await user.click(
      screen.getByRole("checkbox", { name: `Held-out case ${index}` }),
    );
  expect(freeze).toBeDisabled();
  for (const name of [
    "Persona comparator",
    "Fallback when the selector abstains",
  ]) {
    await user.click(screen.getByRole("combobox", { name }));
    await user.click(
      screen.getByRole("option", { name: "claude-acp / model-1 / high" }),
    );
  }
  expect(freeze).toBeEnabled();
  await user.click(freeze);
  await waitFor(() =>
    expect(
      screen.getByText("The request outcome is unavailable"),
    ).toBeVisible(),
  );
  await user.click(
    screen.getByRole("button", { name: "Retry the same reservation" }),
  );
  await waitFor(() =>
    expect(benchmarkApi.freezeSelectorHoldout).toHaveBeenCalledTimes(2),
  );
  const calls = vi.mocked(benchmarkApi.freezeSelectorHoldout).mock.calls;
  expect(calls[0][0]).toEqual(calls[1][0]);
  expect(calls[0][0]).toMatchObject({
    versionIds: versions.map((v) => v.id),
    modelId: "fit",
    minQuality: 0.5,
    personaPrior: ["config-1", "second"],
    fallbackKey: "config-1",
  });
});
