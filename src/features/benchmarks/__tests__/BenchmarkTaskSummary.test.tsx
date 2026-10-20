import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  type CellAttempt,
  TaskSummary,
  taskCells,
  withOpenCells,
} from "../ui/BenchmarkTaskGrid";

afterEach(cleanup);

const attempt = (
  id: string,
  versionId: string,
  repetition: number,
  outcome: string | null,
  phase = "terminal",
): CellAttempt => ({
  id,
  versionId,
  repetition,
  phase,
  outcome,
  finishedAt: phase === "terminal" ? 2000 : null,
  durationMs: phase === "terminal" ? 1000 : null,
  cost: 0.01,
  score: null,
});

const value = (label: string) =>
  screen.getByText(label).nextElementSibling?.textContent;

it("counts cases, not repetitions", () => {
  const cells = taskCells(
    [
      { id: "solved", name: "Solved" },
      { id: "mixed", name: "Mixed" },
      { id: "running", name: "Running" },
      { id: "gap", name: "Gap" },
    ],
    [
      attempt("a", "solved", 0, "pass"),
      attempt("b", "solved", 1, "pass"),
      attempt("c", "solved", 2, "pass"),
      attempt("d", "mixed", 0, "pass"),
      attempt("e", "mixed", 1, "fail"),
      attempt("f", "mixed", 2, "pass"),
      attempt("g", "running", 0, "pass"),
      attempt("h", "running", 1, null, "running"),
    ],
    "running",
  );
  render(<TaskSummary cells={cells} />);
  // Four cases: one passed, one failed on a single repetition, one still
  // working, one nobody measured; the seven passing repetitions are not
  // a count of their own.
  expect(value("Not started")).toBe("1");
  expect(value("In progress")).toBe("1");
  expect(value("Passed")).toBe("1");
  expect(value("Failed")).toBe("1");
  expect(screen.queryByText("Not counted")).toBeNull();
});

it("sets a case that only stopped on infrastructure apart from the not started", () => {
  const cells = taskCells(
    [
      { id: "stopped", name: "Stopped" },
      { id: "gap", name: "Gap" },
    ],
    [attempt("a", "stopped", 0, "infrastructure_failure")],
    "completed",
  );
  render(<TaskSummary cells={cells} />);
  expect(value("Not started")).toBe("1");
  expect(value("Not counted")).toBe("1");
  expect(value("Failed")).toBe("0");
});

it("reads a rendering a finished run still owes its review as not counted", () => {
  const cells = taskCells(
    [{ id: "design", name: "Design" }],
    [
      { ...attempt("a", "design", 0, "pending_review"), runId: "old" },
      { ...attempt("b", "design", 1, "pending_review"), runId: "old" },
      { ...attempt("c", "design", 2, "pending_review"), runId: "old" },
    ],
    (runId) => (runId === "old" ? "completed" : "running"),
  );
  expect(cells[0].dots).toEqual(["stopped", "stopped", "stopped"]);
  expect(cells[0].status).toEqual({
    kind: "unscored",
    outcome: "pending_review",
    durationMs: 1000,
  });
  render(<TaskSummary cells={cells} />);
  expect(value("In progress")).toBe("0");
  expect(value("Not counted")).toBe("1");
});

it("lets the active run's queue and work stand in for what stood before", () => {
  const cells = withOpenCells(
    taskCells(
      [
        { id: "queued", name: "Queued" },
        { id: "working", name: "Working" },
        { id: "kept", name: "Kept" },
      ],
      [
        { ...attempt("a", "queued", 0, "pending_review"), runId: "old" },
        { ...attempt("b", "working", 0, "pending_review"), runId: "old" },
        attempt("c", "kept", 0, "pass"),
        attempt("d", "kept", 1, "pass"),
        attempt("e", "kept", 2, "pass"),
      ],
      () => "completed",
    ),
    new Map([
      ["queued", false],
      ["working", true],
      ["kept", false],
    ]),
  );
  // Queued again with no result yet: not started. Measured now: in
  // progress. Queued again with a result: the result stands until replaced.
  expect(cells.map((cell) => cell.verdict)).toEqual([
    "queued",
    "running",
    "solved",
  ]);
  expect(cells[0].dots).toEqual(["queued", "queued", "queued"]);
  expect(cells[1].dots).toEqual(["running", "queued", "queued"]);
  render(<TaskSummary cells={cells} />);
  expect(value("Not started")).toBe("1");
  expect(value("In progress")).toBe("1");
  expect(value("Passed")).toBe("1");
  expect(screen.queryByText("Not counted")).toBeNull();
});
