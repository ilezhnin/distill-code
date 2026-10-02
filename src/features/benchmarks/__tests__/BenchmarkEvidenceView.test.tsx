import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { benchmarkApi } from "../api/benchmarks";
import { BenchmarkEvidenceView } from "../ui/BenchmarkEvidenceView";
import type { Attempt, BenchmarkDefinition } from "../types";
import { attempt, definition } from "./fixtures";

vi.mock("../api/benchmarks", () => ({
  benchmarkErrorMessage: (error: unknown) => String(error),
  benchmarkApi: {
    getEvidence: vi.fn(),
    listDefinitions: vi.fn(),
    submitReview: vi.fn(),
    rescore: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@/features/stats/lib/usageLedger", () => ({
  projectBenchmarkUsage: vi.fn(),
}));

const visualDefinition: BenchmarkDefinition = {
  ...definition,
  versions: [
    {
      ...definition.versions[0],
      manifest: {
        ...definition.versions[0].manifest,
        evaluator: {
          ...definition.draft.evaluator,
          kind: "browser",
          rubric: "Fallback rubric",
        },
        environment: {
          visualRubric: "Score contrast and legible labels from 0 to 1.",
        },
      },
    },
  ],
};
const visualAttempt: Attempt = {
  ...attempt,
  sessionId: "private-session",
  output: "Captured page output",
  outcome: "fail",
  reason: "Private provider diagnostic",
  evaluations: [
    {
      ...attempt.evaluations[0],
      verdict: "fail",
      score: 0,
      provenance: "protected-browser-v1",
      reason: "Private model diagnostic",
      artifacts: [
        {
          kind: "screenshot",
          path: "/anonymous.png",
          hash: "image-hash",
          label: "model-1 account-1 screenshot",
        },
      ],
    },
  ],
};

function showEvidence() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BenchmarkEvidenceView
        attemptId={attempt.id}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
        onSelectAttempt={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("blind benchmark review", () => {
  afterEach(cleanup);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(benchmarkApi.getEvidence).mockResolvedValue(visualAttempt);
    vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([
      visualDefinition,
    ]);
  });

  it("shows the frozen rubric and artifacts without identity, metadata or transcript before review", async () => {
    showEvidence();
    await screen.findByText("Score contrast and legible labels from 0 to 1.");
    expect(screen.getByText("Captured page output")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Artifact 1" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /Anonymous review/ }),
    ).toBeInTheDocument();
    for (const hidden of [
      "model-1",
      "account-1",
      "claude-acp",
      "private-session",
      "protected-browser-v1",
      "Private model diagnostic",
      "Private provider diagnostic",
    ]) {
      expect(screen.getByRole("dialog")).not.toHaveTextContent(hidden);
    }
    expect(
      screen.queryByText("Selection, usage and provenance"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Open transcript" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Evaluate again" }),
    ).not.toBeInTheDocument();
  });

  it("keeps identity hidden while the frozen definition is still loading", async () => {
    vi.mocked(benchmarkApi.listDefinitions).mockReturnValue(
      new Promise(() => {}),
    );
    showEvidence();
    await screen.findByText("Captured page output");
    expect(screen.getByRole("dialog")).not.toHaveTextContent("model-1");
    expect(
      screen.queryByRole("button", { name: "Record rubric review" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Selection, usage and provenance"),
    ).not.toBeInTheDocument();
  });

  it("reveals identity only after the saved visual review, while retaining failed objective checks", async () => {
    const recorded = {
      ...visualAttempt,
      evaluations: [
        ...visualAttempt.evaluations,
        {
          ...attempt.evaluations[0],
          id: "visual-review",
          provenance: "human_visual",
          score: 0.4,
          verdict: "fail",
          reason: "Labels are clear but contrast is weak.",
        },
      ],
    };
    vi.mocked(benchmarkApi.submitReview).mockImplementation(async () => {
      vi.mocked(benchmarkApi.getEvidence).mockResolvedValue(recorded);
      return recorded;
    });
    showEvidence();
    await screen.findByText("Score contrast and legible labels from 0 to 1.");
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Review score (0–1)" }),
      { target: { value: "0.4" } },
    );
    await userEvent.type(
      screen.getByRole("textbox", { name: "Review evidence" }),
      "Labels are clear but contrast is weak.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Record rubric review" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.submitReview).toHaveBeenCalledWith(
        attempt.id,
        0.4,
        "Labels are clear but contrast is weak.",
        null,
      ),
    );
    await screen.findByRole("button", { name: "Open transcript" });
    expect(
      screen.getByRole("heading", { name: /model-1/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Private model diagnostic")).toBeInTheDocument();
    expect(recorded.outcome).toBe("fail");
    expect(recorded.evaluations[0].score).toBe(0);
    expect(benchmarkApi.rescore).not.toHaveBeenCalled();
  });

  it("does not offer manual scores for an objective evaluator without a published review rubric", async () => {
    vi.mocked(benchmarkApi.getEvidence).mockResolvedValue(attempt);
    vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([definition]);
    showEvidence();
    await screen.findByRole("heading", { name: /model-1/ });
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record rubric review" }),
    ).not.toBeInTheDocument();
    expect(benchmarkApi.submitReview).not.toHaveBeenCalled();
  });
});

describe("creative rubric review", () => {
  afterEach(cleanup);
  const creativeDefinition: BenchmarkDefinition = {
    ...definition,
    versions: [
      {
        ...definition.versions[0],
        manifest: {
          ...definition.versions[0].manifest,
          evaluator: {
            ...definition.draft.evaluator,
            kind: "rubric",
            rubric: "Score the drawing against the brief.",
          },
          facets: {
            ...definition.versions[0].manifest.facets,
            outputFormat: "svg",
          },
          environment: {
            rubricCriteria: [
              { id: "adherence", label: "Prompt adherence", weight: 50 },
              { id: "craft", label: "Craft", weight: 50 },
            ],
          },
        },
      },
    ],
  };
  const drawing: Attempt = {
    ...attempt,
    outcome: null,
    output: [
      "```svg",
      "<svg xmlns='http://www.w3.org/2000/svg'><rect width='4' height='4'/></svg>",
      "```",
    ].join("\n"),
    evaluations: [
      {
        ...attempt.evaluations[0],
        verdict: "pending_review",
        score: null,
        reason: "Human rubric review is required",
      },
    ],
  };

  it("renders the drawing without scripts and records every criterion behind the weighted score", async () => {
    vi.mocked(benchmarkApi.getEvidence).mockResolvedValue(drawing);
    vi.mocked(benchmarkApi.listDefinitions).mockResolvedValue([
      creativeDefinition,
    ]);
    vi.mocked(benchmarkApi.submitReview).mockResolvedValue(drawing);
    showEvidence();
    await screen.findByText("Score the drawing against the brief.");
    const frame = screen.getByTitle("Rendered output");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain(
      "<rect width='4' height='4'/>",
    );
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame.getAttribute("srcdoc")).not.toContain("```");
    fireEvent.change(
      screen.getByRole("slider", { name: "Prompt adherence · weight 50" }),
      { target: { value: "8" } },
    );
    fireEvent.change(
      screen.getByRole("slider", { name: "Craft · weight 50" }),
      { target: { value: "6" } },
    );
    expect(screen.getByText("Weighted score 700 of 1000")).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Review evidence" }),
      "Lighthouse present, the beam is flat.",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Record rubric review" }),
    );
    await waitFor(() =>
      expect(benchmarkApi.submitReview).toHaveBeenCalledWith(
        attempt.id,
        0.7,
        "Lighthouse present, the beam is flat.",
        { adherence: 0.8, craft: 0.6 },
      ),
    );
  });
});
