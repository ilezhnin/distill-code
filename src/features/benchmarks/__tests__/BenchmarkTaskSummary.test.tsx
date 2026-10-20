import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  type CellAttempt,
  TaskSummary,
  taskCells,
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
