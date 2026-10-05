import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RunSummary } from "../types";
import { BenchmarkActivity } from "../ui/BenchmarkActivity";
import { configuration, runSummary } from "./fixtures";

vi.mock("../hooks/useBenchmarks", () => ({
  modelNameKey: (entry: { modelId: string }) => entry.modelId,
  useModelNames: () => new Map([["model-1", "Model One"]]),
}));

const many = [1, 2, 3, 4, 5].map((n) => ({
  ...configuration,
  id: `config-${n}`,
  modelId: `model-${n}`,
  effort: n === 1 ? "max" : "default",
}));

function show(run: Partial<RunSummary>) {
  render(
    <BenchmarkActivity
      runs={[{ ...runSummary, state: "running", ...run }]}
      onOpenRun={vi.fn()}
    />,
  );
  return within(screen.getByRole("button"));
}

afterEach(cleanup);

it("names the model of a run that waits with nothing running", () => {
  const row = show({
    request: { ...runSummary.request, configurations: [many[0]] },
    attemptCount: 66,
    settledCount: 20,
    openCells: [{ configurationId: "config-1", versionId: "version-1" }],
  });
  expect(row.getByText("Model One")).toBeInTheDocument();
  expect(row.getByText("max")).toBeInTheDocument();
  expect(row.getByText("20 / 66")).toBeInTheDocument();
});

it("names the first models of a matrix and counts the rest", () => {
  const row = show({
    request: { ...runSummary.request, configurations: many },
    openCells: many.map((entry) => ({
      configurationId: entry.id,
      versionId: "version-1",
      running: true,
    })),
  });
  expect(row.getByText("Model One")).toBeInTheDocument();
  expect(row.getByText("model-3")).toBeInTheDocument();
  expect(row.queryByText("model-4")).not.toBeInTheDocument();
  expect(row.getByText("+2")).toBeInTheDocument();
  // The CLI's "default" is no effort level and is never named as one.
  expect(row.queryByText("default")).not.toBeInTheDocument();
});
