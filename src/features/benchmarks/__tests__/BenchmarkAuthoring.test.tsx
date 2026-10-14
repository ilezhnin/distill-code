import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { createBenchmarkDraft } from "../lib/benchmarkDraft";
import { BenchmarkEditor } from "../ui/BenchmarkEditor";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { definition, draft } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    saveDraft: vi.fn(),
    validateDraft: vi.fn(),
    publishVersion: vi.fn(),
  },
}));

function setup(evaluator = draft.evaluator) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BenchmarkEditor
        definition={{ ...definition, draft: { ...draft, evaluator } }}
        onSaved={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

describe("benchmark check authoring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = () => false;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.scrollIntoView = () => {};
    useBenchmarkViewStore.setState({ dirty: false, pending: null });
    vi.mocked(benchmarkApi.saveDraft).mockImplementation(
      async (_id, _revision, saved) => ({ ...definition, draft: saved }),
    );
  });
  afterEach(cleanup);

  it("offers two datasets and defaults a new test to training", async () => {
    const user = setup();
    expect(createBenchmarkDraft().split).toBe("train");
    await user.click(screen.getByRole("combobox", { name: "Dataset split" }));
    expect(
      screen.queryByRole("option", { name: "Development" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Training" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Held-out evaluation" }),
    ).toBeInTheDocument();
  });

  it("derives sanity references and a revision when a simple expected answer changes", async () => {
    setup();
    expect(screen.queryByText("Evaluator revision")).not.toBeInTheDocument();
    expect(screen.queryByText("Known passing output")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Files", { selector: "summary" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(
      screen.queryByRole("textbox", { name: "License" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Source / provenance" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Expected answer" }), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(benchmarkApi.saveDraft).toHaveBeenCalled());
    const saved = vi.mocked(benchmarkApi.saveDraft).mock.calls[0][2];
    expect(saved.evaluator.expected).toBe("42");
    expect(saved.evaluator.knownGood).toBe("42");
    expect(saved.evaluator.knownBad).not.toBe("42");
    expect(saved.evaluator.revision).not.toBe(draft.evaluator.revision);
    expect(saved.source).toBe(draft.source);
    expect(saved.license).toBe(draft.license);
  });

  it("preserves an imported repository checker while changing only its program", async () => {
    const spec = {
      command: ["python3", "check.py"],
      files: [{ path: "check.py", content: "print(1)" }],
      probe: { command: ["python3", "probe.py"], files: [] },
      timeoutSeconds: 80,
      extension: { frozen: true },
    };
    setup({
      ...draft.evaluator,
      kind: "repository",
      expected: JSON.stringify(spec),
    });
    expect(screen.getByRole("combobox", { name: "Method" })).toHaveTextContent(
      "Repository changes",
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Check program" }), {
      target: { value: "python" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(benchmarkApi.saveDraft).toHaveBeenCalled());
    const saved = vi.mocked(benchmarkApi.saveDraft).mock.calls[0][2];
    expect(JSON.parse(saved.evaluator.expected)).toEqual({
      ...spec,
      command: ["python", "check.py"],
    });
    expect(saved.evaluator.knownGood).toBe(draft.evaluator.knownGood);
    expect(saved.evaluator.knownBad).toBe(draft.evaluator.knownBad);
  });

  it("blocks save while a case contains invalid JSON and retains valid edits", async () => {
    setup({
      ...draft.evaluator,
      kind: "javascript",
      expected: JSON.stringify({
        functionName: "solve",
        argsCases: [{ args: [2], expected: 4 }],
        immutableArgs: [0],
      }),
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Inputs (JSON array)" }),
      { target: { value: "[" } },
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    expect(useBenchmarkViewStore.getState().dirty).toBe(true);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Inputs (JSON array)" }),
      { target: { value: "[3]" } },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Expected answer" }), {
      target: { value: "9" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(benchmarkApi.saveDraft).toHaveBeenCalled());
    expect(
      JSON.parse(
        vi.mocked(benchmarkApi.saveDraft).mock.calls[0][2].evaluator.expected,
      ),
    ).toEqual({
      functionName: "solve",
      argsCases: [{ args: [3], expected: 9 }],
      immutableArgs: [0],
    });
  });

  it("removes an invalid case without leaving a stale save blocker", () => {
    setup({
      ...draft.evaluator,
      kind: "javascript",
      expected: JSON.stringify({
        functionName: "solve",
        argsCases: [
          { args: [2], expected: 4 },
          { args: [3], expected: 9 },
        ],
      }),
    });
    fireEvent.change(
      screen.getAllByRole("textbox", { name: "Inputs (JSON array)" })[0],
      { target: { value: "[" } },
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    expect(
      screen.getByRole("textbox", { name: "Inputs (JSON array)" }),
    ).toHaveValue("[\n  3\n]");
    expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled();
  });
});
