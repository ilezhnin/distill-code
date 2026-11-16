import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { benchmarkApi } from "../api/benchmarks";
import { mutationShare } from "../lib/benchmarkMutation";
import { BenchmarkCarriedAnswers } from "../ui/BenchmarkCarriedAnswers";
import { BenchmarkImportDialog } from "../ui/BenchmarkManagementDialogs";
import { MutationShare } from "../ui/BenchmarkMutationShare";
import { definition, draft } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkApi: {
    importDefinition: vi.fn(),
    publishVersion: vi.fn(),
    republishEvaluator: vi.fn(),
    evaluateCarried: vi.fn(),
    carryStatus: vi.fn(),
  },
  benchmarkErrorMessage: (failure: unknown) =>
    failure instanceof Error ? failure.message : String(failure),
}));

function wrap(content: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{content}</QueryClientProvider>,
  );
}

/** An invented evaluation: one correct implementation, three defective. */
const details = {
  runtimeRevision: "invented",
  mutation: {
    scoring: "mutation-share",
    correctAccepted: 1,
    correctTotal: 1,
    defectsCaught: 2,
    defectTotal: 3,
    implementations: [
      { case: 0, position: 0, expected: "accept", matched: true },
      { case: 0, position: 1, expected: "reject", matched: true },
      { case: 1, position: 0, expected: "reject", matched: true },
      { case: 1, position: 1, expected: "reject", matched: false },
    ],
  },
};

describe("share-scored suite evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads the counts and names what the suite got wrong", () => {
    expect(mutationShare(details)).toEqual({
      correctAccepted: 1,
      correctTotal: 1,
      defectsCaught: 2,
      defectTotal: 3,
      missed: ["2.2"],
      refused: [],
    });
    const strict = structuredClone(details);
    strict.mutation.correctAccepted = 0;
    strict.mutation.implementations[0].matched = false;
    expect(mutationShare(strict)?.refused).toEqual(["1.1"]);
    // Any other evaluation has no such counts.
    expect(mutationShare({ runtimeRevision: "invented" })).toBeNull();
    expect(mutationShare({ mutation: { correctAccepted: "1" } })).toBeNull();
    expect(mutationShare(null)).toBeNull();
  });

  it("shows correct implementations accepted and defects caught", () => {
    const view = render(<MutationShare details={details} />);
    expect(
      screen.getByText("Correct implementations accepted").parentElement,
    ).toHaveTextContent("Correct implementations accepted 1/1");
    expect(screen.getByText("Defects caught").parentElement).toHaveTextContent(
      "Defects caught 2/3",
    );
    expect(
      screen.getByText("Not caught (bundle.implementation)").parentElement,
    ).toHaveTextContent("2.2");
    view.rerender(<MutationShare details={{ runtimeRevision: "invented" }} />);
    expect(screen.queryByText("Defects caught")).not.toBeInTheDocument();
  });

  it("imports a definition as the next version of its test and evaluates the saved answers", async () => {
    const version = { ...definition.versions[0], carriesFrom: "earlier" };
    vi.mocked(benchmarkApi.republishEvaluator).mockResolvedValue(version);
    vi.mocked(benchmarkApi.evaluateCarried).mockResolvedValue({
      versionId: version.id,
      total: 3,
      evaluated: 0,
      running: true,
    });
    const onImported = vi.fn();
    wrap(<BenchmarkImportDialog onClose={vi.fn()} onImported={onImported} />);
    fireEvent.change(screen.getByLabelText("Definition JSON"), {
      target: { value: JSON.stringify(draft) },
    });
    await userEvent.click(
      screen.getByRole("checkbox", { name: /keep its measured answers/ }),
    );
    // Keeping the answers publishes; the plain option follows it.
    expect(
      screen.getByRole("checkbox", { name: /Publish definitions/ }),
    ).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(onImported).toHaveBeenCalledWith(version.definitionId),
    );
    expect(benchmarkApi.republishEvaluator).toHaveBeenCalledWith(draft);
    expect(benchmarkApi.evaluateCarried).toHaveBeenCalledWith(version.id);
    expect(benchmarkApi.importDefinition).not.toHaveBeenCalled();
    expect(benchmarkApi.publishVersion).not.toHaveBeenCalled();
  });

  it("shows how many carried answers are evaluated and evaluates the rest on request", async () => {
    vi.mocked(benchmarkApi.carryStatus).mockResolvedValue({
      versionId: "version",
      total: 5,
      evaluated: 2,
      running: false,
      lastError: "The sandbox was busy",
    });
    vi.mocked(benchmarkApi.evaluateCarried).mockResolvedValue({
      versionId: "version",
      total: 5,
      evaluated: 2,
      running: true,
    });
    wrap(<BenchmarkCarriedAnswers versionId="version" />);
    expect(
      await screen.findByText(
        "Saved answers of the previous version evaluated by this check: 2 of 5",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The last evaluation stopped: The sandbox was busy",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Evaluate saved answers" }),
    );
    expect(benchmarkApi.evaluateCarried).toHaveBeenCalledWith("version");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Evaluating in the background; no model is called.",
    );
    expect(
      screen.queryByRole("button", { name: "Evaluate saved answers" }),
    ).not.toBeInTheDocument();
  });
});
