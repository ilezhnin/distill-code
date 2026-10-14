import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkEditor } from "../ui/BenchmarkEditor";
import { definition } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: String,
  benchmarkApi: { saveDraft: vi.fn() },
}));

afterEach(cleanup);

it("saves exact authors, preserves legacy provenance and keeps the remaining row after removal", async () => {
  const original = {
    ...definition,
    draft: {
      ...definition.draft,
      environment: {
        authoredBy: [
          "legacy-author",
          {
            providerId: "first-provider",
            modelId: "first-model",
            effort: "high",
          },
        ],
      },
    },
  };
  vi.mocked(benchmarkApi.saveDraft).mockImplementation(
    async (_id, _revision, draft) => ({
      ...original,
      draft,
      draftRevision: 2,
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <BenchmarkEditor definition={original} onSaved={vi.fn()} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Advanced" }));
  await user.click(screen.getByRole("button", { name: "Add author" }));
  for (const [label, value] of [
    ["Provider ID", "second-provider"],
    ["Model ID", "second-model"],
    ["Reasoning effort", "xhigh"],
  ])
    fireEvent.change(screen.getAllByLabelText(label)[1], { target: { value } });
  await user.click(screen.getAllByRole("button", { name: "Remove author" })[0]);
  expect(screen.getByLabelText("Model ID")).toHaveValue("second-model");
  await user.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(benchmarkApi.saveDraft).toHaveBeenCalled());
  const saved = vi.mocked(benchmarkApi.saveDraft).mock.calls[0][2];
  expect(saved.environment).toEqual({
    authoredBy: [
      {
        providerId: "second-provider",
        modelId: "second-model",
        effort: "xhigh",
      },
    ],
    legacyAuthoredBy: ["legacy-author"],
  });
});
