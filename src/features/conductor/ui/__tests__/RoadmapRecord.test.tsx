import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { roadmapRenderer } from "../RoadmapRecord";

const Record = roadmapRenderer.component;

const ROADMAP = {
  goal: "math.js has subtract and a changelog",
  status: "in-progress",
  stages: [
    {
      title: "add subtract to src/math.js",
      status: "done",
      evidence: ["src/math.js", "src/math.test.js"],
    },
    { title: "write notes/CHANGELOG.md", status: "active" },
  ],
  note: "one stage left",
};

function draw(code: string, isIncomplete = false) {
  return render(
    <Record
      code={code}
      isIncomplete={isIncomplete}
      language="distill-roadmap"
    />,
  );
}

describe("RoadmapRecord", () => {
  it("draws the roadmap as its goal and stages, never as JSON", async () => {
    const user = userEvent.setup();
    draw(JSON.stringify(ROADMAP));

    expect(
      screen.getByText("Roadmap · in progress · 1 of 2 stages done"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("math.js has subtract and a changelog"),
    ).toBeInTheDocument();
    expect(screen.getByText("Note: one stage left")).toBeInTheDocument();
    expect(screen.queryByText(/"goal"/)).not.toBeInTheDocument();
    expect(
      screen.getByText("write notes/CHANGELOG.md · in progress"),
    ).toBeInTheDocument();
    // Evidence folds under the stage that cites it.
    expect(screen.queryByText("src/math.test.js")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "add subtract to src/math.js · done",
      }),
    );
    expect(screen.getByText("src/math.test.js")).toBeInTheDocument();
  });

  it("says it is being written while the fence streams", () => {
    draw('{"goal":"half', true);
    expect(screen.getByText("Writing the roadmap…")).toBeInTheDocument();
  });

  it("keeps an unreadable block behind a notice line", async () => {
    const user = userEvent.setup();
    draw('{"status":"paused"}');
    expect(screen.getByText("Roadmap could not be read")).toBeInTheDocument();
    expect(screen.queryByText(/"status"/)).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Roadmap could not be read" }),
    );
    expect(screen.getByText(/"status"/)).toBeInTheDocument();
  });
});
