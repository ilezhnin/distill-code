import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkDiagnosticHistory } from "../ui/BenchmarkDiagnosticHistory";
import { diagnostic } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) => String(error),
  benchmarkApi: { listDiagnostics: vi.fn() },
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  projectBenchmarkUsageBatch: vi.fn(),
}));

function show(blind = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = (attemptId: string) => (
    <QueryClientProvider client={client}>
      <BenchmarkDiagnosticHistory
        key={attemptId}
        attemptId={attemptId}
        blind={blind}
        onReveal={vi.fn()}
      />
    </QueryClientProvider>
  );
  return { ...render(view("attempt-1")), view };
}

describe("durable benchmark diagnostics", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(benchmarkApi.listDiagnostics).mockResolvedValue({
      items: [diagnostic],
      nextBefore: null,
    });
  });

  it("reads only on expansion and renders recorded times, count, judge and escaped context", async () => {
    const user = userEvent.setup();
    show();
    expect(benchmarkApi.listDiagnostics).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    expect(await screen.findByText(diagnostic.message)).toBeInTheDocument();
    expect(benchmarkApi.listDiagnostics).toHaveBeenCalledExactlyOnceWith(
      "attempt-1",
      null,
      50,
    );
    const entry = within(
      screen.getByRole("list", { name: "Recorded diagnostic events" }),
    ).getByRole("listitem");
    expect(entry).toHaveTextContent("Occurrences: 3");
    expect(entry).toHaveTextContent("Judge · codex-acp · invented-judge");
    expect(
      [...entry.querySelectorAll("time")].map((time) => time.dateTime),
    ).toEqual([
      new Date(diagnostic.firstAt).toISOString(),
      new Date(diagnostic.lastAt).toISOString(),
    ]);
    await user.click(screen.getByText("Recorded context"));
    expect(entry).toHaveTextContent("<script>invented context</script>");
    expect(entry.querySelector("script")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    expect(benchmarkApi.listDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("keeps loaded events on a page error, retries that cursor, and refreshes from newest", async () => {
    const user = userEvent.setup();
    const older = {
      ...diagnostic,
      sequence: 8,
      message: "Invented earlier refusal",
    };
    vi.mocked(benchmarkApi.listDiagnostics)
      .mockResolvedValueOnce({ items: [diagnostic], nextBefore: 20 })
      .mockRejectedValueOnce(new Error("Invented page read failed"))
      .mockResolvedValueOnce({ items: [older], nextBefore: null })
      .mockResolvedValueOnce({
        items: [{ ...diagnostic, occurrences: 4 }],
        nextBefore: 20,
      });
    show();
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Load older events" }),
    );
    expect(
      await screen.findByText(/Could not load diagnostic history/),
    ).toHaveTextContent("Invented page read failed");
    expect(screen.getByText(diagnostic.message)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(older.message)).toBeInTheDocument();
    expect(benchmarkApi.listDiagnostics).toHaveBeenNthCalledWith(
      2,
      "attempt-1",
      20,
      50,
    );
    expect(benchmarkApi.listDiagnostics).toHaveBeenNthCalledWith(
      3,
      "attempt-1",
      20,
      50,
    );
    expect(
      screen.queryByRole("button", { name: "Load older events" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Refresh history" }));
    await waitFor(() =>
      expect(benchmarkApi.listDiagnostics).toHaveBeenCalledTimes(4),
    );
    expect(benchmarkApi.listDiagnostics).toHaveBeenLastCalledWith(
      "attempt-1",
      null,
      50,
    );
    await screen.findByText(diagnostic.message);
    expect(screen.queryByText(older.message)).not.toBeInTheDocument();
    expect(screen.getByRole("listitem")).toHaveTextContent("Occurrences: 4");
  });

  it("distinguishes old empty evidence from a failed first read", async () => {
    const user = userEvent.setup();
    vi.mocked(benchmarkApi.listDiagnostics)
      .mockRejectedValueOnce(new Error("Invented storage failure"))
      .mockResolvedValueOnce({ items: [], nextBefore: null });
    show();
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    await screen.findByText(/Could not load diagnostic history/);
    expect(
      screen.queryByText(/No diagnostic events were recorded/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/Earlier attempts may have no history/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Could not load diagnostic history/),
    ).not.toBeInTheDocument();
  });

  it("withholds identity-bearing labels, messages and context during blind review", async () => {
    const user = userEvent.setup();
    vi.mocked(benchmarkApi.listDiagnostics).mockResolvedValue({
      items: [
        {
          ...diagnostic,
          stage: "invented-private-stage",
          code: "invented-private-code",
        },
      ],
      nextBefore: null,
    });
    show(true);
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    await screen.findAllByText(/Details hidden/);
    const list = screen.getByRole("list", {
      name: "Recorded diagnostic events",
    });
    for (const hidden of [
      diagnostic.message,
      "invented-private-stage",
      "invented-private-code",
      "account-1",
      "model-1",
      "invented-judge",
      "invented context",
    ])
      expect(list).not.toHaveTextContent(hidden);
    expect(screen.queryByText("Recorded context")).not.toBeInTheDocument();
  });

  it("starts another attempt closed without showing or fetching the previous history", async () => {
    const user = userEvent.setup();
    const rendered = show();
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    await screen.findByText(diagnostic.message);
    rendered.rerender(rendered.view("attempt-2"));
    expect(screen.queryByText(diagnostic.message)).not.toBeInTheDocument();
    expect(benchmarkApi.listDiagnostics).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("button", { name: "Diagnostic history" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.listDiagnostics).toHaveBeenLastCalledWith(
        "attempt-2",
        null,
        50,
      ),
    );
  });
});
