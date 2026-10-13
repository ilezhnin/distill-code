import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkDetail } from "../ui/BenchmarkDetail";
import { useBenchmarkViewStore } from "../stores/benchmarkViewStore";
import { definition, draft } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: {
    listAttempts: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn(),
    publishVersion: vi.fn(),
  },
}));

const history = {
  ...definition,
  draft: { ...draft, prompt: "Unpublished instructions" },
  versions: [
    {
      ...definition.versions[0],
      id: "v2",
      publishedAt: 2000,
      manifest: { ...draft, prompt: "Current instructions" },
    },
    {
      ...definition.versions[0],
      id: "v1",
      publishedAt: 1000,
      manifest: {
        ...draft,
        prompt: "Original instructions",
        limits: { ...draft.limits, timeoutSeconds: 60 },
      },
    },
  ],
};

function setup(record = history) {
  const onRun = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BenchmarkDetail
        definition={record}
        initialWorkClassId="general"
        onSaved={vi.fn()}
        onRun={onRun}
        onEvidence={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), onRun };
}

describe("benchmark version history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.hasPointerCapture = () => false;
    HTMLElement.prototype.setPointerCapture = () => {};
    HTMLElement.prototype.releasePointerCapture = () => {};
    HTMLElement.prototype.scrollIntoView = () => {};
    useBenchmarkViewStore.setState({ dirty: false, pending: null });
  });
  afterEach(cleanup);

  it("shows frozen versions instead of draft content and only previews the current one", async () => {
    const { user, onRun } = setup();
    expect(screen.getByText("Current instructions")).toBeInTheDocument();
    expect(
      screen.queryByText("Unpublished instructions"),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Preview this version" }),
    );
    expect(onRun).toHaveBeenCalledWith("v2");
    await user.click(screen.getByRole("tab", { name: "v1" }));
    expect(screen.getByText("Original instructions")).toBeInTheDocument();
    expect(screen.getByText("60")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.queryByText("Current instructions")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview this version" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save draft" }),
    ).not.toBeInTheDocument();
  });

  it("keeps results scoped to the selected publication when switching versions", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Results" }));
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith(
        expect.objectContaining({ versionIds: ["v2"], offset: 0 }),
      ),
    );
    await user.click(screen.getByRole("tab", { name: "v1" }));
    await waitFor(() =>
      expect(benchmarkApi.listAttempts).toHaveBeenLastCalledWith(
        expect.objectContaining({ versionIds: ["v1"], offset: 0 }),
      ),
    );
    expect(screen.getByRole("tab", { name: "Results" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("protects unsaved drafts when opening a publication", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("tab", { name: "Draft" }));
    await user.type(
      screen.getByRole("textbox", { name: "Prompt" }),
      " changed",
    );
    await user.click(screen.getByRole("tab", { name: "v1" }));
    expect(useBenchmarkViewStore.getState().pending).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "Prompt" })).toHaveValue(
      "Unpublished instructions changed",
    );
    act(() => useBenchmarkViewStore.getState().resolveNavigation(false));
    expect(screen.getByRole("tab", { name: "Draft" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.click(screen.getByRole("tab", { name: "v1" }));
    act(() => useBenchmarkViewStore.getState().resolveNavigation(true));
    expect(screen.getByText("Original instructions")).toBeInTheDocument();
    expect(benchmarkApi.saveDraft).not.toHaveBeenCalled();
  });

  it("keeps the latest publication read-only when the whole test is archived", () => {
    setup({ ...history, archived: true });
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview this version" }),
    ).not.toBeInTheDocument();
  });

  it("uses one type selector and preserves the existing variant group on save", async () => {
    const { user } = setup();
    vi.mocked(benchmarkApi.saveDraft).mockResolvedValue(history);
    await user.click(screen.getByRole("tab", { name: "Draft" }));
    expect(
      screen.queryByRole("textbox", { name: "Category" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Variant group" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(screen.getByRole("option", { name: "Writing" }));
    await user.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(benchmarkApi.saveDraft).toHaveBeenCalledWith(
        definition.id,
        definition.draftRevision,
        expect.objectContaining({
          workClassId: "writing",
          category: "writing",
          taskFamily: draft.taskFamily,
        }),
      ),
    );
  });
});
