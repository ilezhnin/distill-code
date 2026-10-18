import { describe, expect, it } from "vitest";
import { type CellAttempt, taskCells } from "../ui/BenchmarkTaskGrid";

const attempt = (
  id: string,
  repetition: number,
  outcome: string | null,
): CellAttempt => ({
  id,
  versionId: "version-1",
  repetition,
  phase: "terminal",
  outcome,
  finishedAt: 2000,
  durationMs: 1000,
  cost: 0.01,
  score: null,
});

describe("task grid repetitions", () => {
  it("marks only quality outcomes failed and leaves unscored ones as gaps", () => {
    const [cell] = taskCells(
      [{ id: "version-1", name: "Task" }],
      [
        attempt("a", 0, "fail"),
        attempt("b", 1, "infrastructure_failure"),
        attempt("c", 2, "resource_busy"),
        attempt("d", 3, "budget_timeout"),
        attempt("e", 4, "cancelled"),
        attempt("f", 5, "pass"),
      ],
      "completed",
    );
    expect(cell.dots).toEqual([
      "failed",
      "stopped",
      "stopped",
      "failed",
      "stopped",
      "passed",
    ]);
    expect(cell.verdict).toBe("failed");
  });

  it("does not call a test failed that only stopped on infrastructure", () => {
    const [cell] = taskCells(
      [{ id: "version-1", name: "Task" }],
      [attempt("a", 0, "infrastructure_failure")],
      "completed",
      1,
    );
    expect(cell.dots).toEqual(["stopped"]);
    expect(cell.verdict).toBe("queued");
  });
});
