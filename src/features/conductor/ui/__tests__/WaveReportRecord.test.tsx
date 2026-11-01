import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { waveReportRenderer } from "../WaveReportRecord";

const Record = waveReportRenderer.component;

const REPORT = {
  status: "completed",
  summary: "Rewrote the tick loop and kept the digest order.",
  decisions: ["Kept the queue", "Dropped the retry"],
  artifacts: [{ label: "waveEngine.ts", path: "src/features/waveEngine.ts" }],
  risks: ["No end-to-end run"],
  needsOperator: false,
  nextSuggestedTask: "Run the regression suite",
};

function draw(code: string, isIncomplete = false) {
  return render(
    <Record
      code={code}
      isIncomplete={isIncomplete}
      language="distill-report"
    />,
  );
}

describe("WaveReportRecord", () => {
  it("draws the report as its outcome and summary, never as JSON", async () => {
    const user = userEvent.setup();
    draw(JSON.stringify(REPORT));

    expect(screen.getByText("Report · completed")).toBeInTheDocument();
    expect(screen.getByTestId("wave-report-summary")).toHaveTextContent(
      "Rewrote the tick loop and kept the digest order.",
    );
    expect(screen.queryByText(/"status"/)).not.toBeInTheDocument();
    expect(screen.queryByText("Kept the queue")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", {
        name: "2 decisions, 1 file, 1 risk, a next step",
      }),
    );
    const details = screen.getByTestId("wave-report-details");
    expect(details).toHaveTextContent("Kept the queue");
    expect(details).toHaveTextContent(
      "waveEngine.ts (src/features/waveEngine.ts)",
    );
    expect(details).toHaveTextContent("No end-to-end run");
    expect(details).toHaveTextContent("Run the regression suite");
  });

  it("says why a blocked step is blocked", () => {
    draw(
      JSON.stringify({
        status: "blocked",
        summary: "",
        reason: "The fixture the brief names does not exist.",
      }),
    );
    expect(screen.getByText("Report · blocked")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The worker is blocked: The fixture the brief names does not exist.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("wave-report-summary")).toHaveTextContent(
      "The report has no summary.",
    );
  });

  it("asks for the operator when the worker did", () => {
    draw(
      JSON.stringify({
        status: "failed",
        summary: "Tests fail.",
        needsOperator: true,
      }),
    );
    expect(screen.getByText("Report · failed")).toBeInTheDocument();
    expect(screen.getByText("Needs the operator.")).toBeInTheDocument();
  });

  it("keeps an unreadable block one click away under a plain line", async () => {
    const user = userEvent.setup();
    draw("{ not json");
    expect(screen.queryByText("{ not json")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Report could not be read" }),
    );
    expect(screen.getByText("{ not json")).toBeInTheDocument();
  });

  it("says the report is being written while the fence is open", () => {
    draw('{"status": "comp', true);
    expect(screen.getByText("Writing the report…")).toBeInTheDocument();
    expect(screen.queryByText(/status/)).not.toBeInTheDocument();
  });
});
