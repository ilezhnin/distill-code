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
