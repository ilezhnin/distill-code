import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type StatusAttempt,
  TestStatusMark,
  testStatus,
} from "../ui/BenchmarkTestStatus";

afterEach(cleanup);

const HOUR = 3_600_000;
const judging: StatusAttempt = {
  id: "a",
  phase: "awaiting_judges",
  outcome: null,
  finishedAt: null,
  durationMs: null,
  startedAt: 0,
};
const collecting: StatusAttempt = { ...judging, phase: "collecting" };

describe("test status in a stopped run", () => {
  it.each([
    "Waiting for local resources to list judge models: measured CPU load is above the light-job admission line",
    "Waiting for local resources to judge: the local queue is full",
  ])("names the local resource wait while judging is deferred: %s", (reason) => {
    const status = testStatus(
      [{ ...judging, reason, waitUntil: 60_000 }],
      new Map(),
      "running",
    );
    expect(status).toEqual({
      kind: "waiting",
      reason,
      stopped: false,
      until: 60_000,
    });
    render(<TestStatusMark status={status} now={1_000} />);
    expect(screen.getByText("Waiting for resources")).toHaveAttribute(
      "title",
      reason,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not show a running judge clock for a terminal failed panel", () => {
    const status = testStatus(
      [
        {
          ...judging,
          phase: "terminal",
          outcome: "pending_review",
          finishedAt: 20_000,
        },
      ],
      new Map(),
      "needs_attention",
    );
    expect(status?.kind).toBe("unscored");
    const { container } = render(
      <TestStatusMark status={status} now={4 * HOUR} />,
    );
    expect(container).toHaveTextContent("Awaiting review");
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("shows a resource wait while a sealed answer awaits its evaluator", () => {
    const reason =
      "Waiting for local resources to evaluate: local queue is full";
    expect(
      testStatus(
        [{ ...collecting, reason, waitUntil: 120_000 }],
        new Map(),
        "running",
      ),
    ).toEqual({
      kind: "waiting",
      reason,
      stopped: false,
      until: 120_000,
    });
  });
  it("reads paused, with no clock and no spinner, while the run is paused", () => {
    for (const attempt of [judging, collecting]) {
      const status = testStatus([attempt], new Map(), "paused");
      expect(status).toEqual({ kind: "paused", runState: "paused" });
      const { container, unmount } = render(
        <TestStatusMark status={status} now={4 * HOUR} />,
      );
      expect(container).toHaveTextContent("Paused");
      expect(container).not.toHaveTextContent(/\d/);
      expect(screen.queryByRole("status")).toBeNull();
      expect(container.querySelector("svg")).toBeNull();
      unmount();
    }
  });

  it("keeps the live clock while a flight may still land", () => {
    for (const state of [
      "running",
      "pausing",
      "cancelling",
      "needs_attention",
    ]) {
      expect(testStatus([judging], new Map(), state)?.kind).toBe("judging");
      expect(testStatus([collecting], new Map(), state)?.kind).toBe("running");
    }
  });
});
