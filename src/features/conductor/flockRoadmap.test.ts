import { describe, expect, it } from "vitest";

import {
  MAX_ROADMAP_STAGES,
  parseFlockRoadmap,
  renderRoadmapForPrompt,
  roadmapProgress,
} from "./flockRoadmap";

function fence(body: string): string {
  return `Here is where we stand.\n\n\`\`\`distill-roadmap\n${body}\n\`\`\``;
}

describe("parseFlockRoadmap", () => {
  it("reads a roadmap with its stages and evidence", () => {
    const parse = parseFlockRoadmap(
      fence(
        '{"goal":"Make the game playable","status":"in-progress","stages":[{"title":"Port the save system","status":"done","evidence":["docs/STATUS.md"]},{"title":"Port the dialogue system","status":"active"}],"note":"two stages left"}',
      ),
    );
    expect(parse.kind).toBe("roadmap");
    if (parse.kind !== "roadmap") return;
    expect(parse.roadmap).toEqual({
      goal: "Make the game playable",
      status: "in-progress",
      stages: [
        {
          title: "Port the save system",
          status: "done",
          evidence: ["docs/STATUS.md"],
        },
        { title: "Port the dialogue system", status: "active", evidence: [] },
      ],
      note: "two stages left",
    });
    expect(roadmapProgress(parse.roadmap)).toEqual({ done: 1, total: 2 });
    expect(renderRoadmapForPrompt(parse.roadmap)).toContain(
      "1. [done] Port the save system — evidence: docs/STATUS.md",
    );
  });

  it("is nothing for a message without the fence", () => {
    expect(parseFlockRoadmap("Just prose.")).toEqual({ kind: "none" });
  });

  it("defaults the status to in-progress and refuses an unknown one", () => {
    const defaulted = parseFlockRoadmap(fence('{"goal":"g","stages":[]}'));
    expect(defaulted).toMatchObject({
      kind: "roadmap",
      roadmap: { status: "in-progress" },
    });
    expect(
      parseFlockRoadmap(fence('{"goal":"g","status":"finished"}')),
    ).toMatchObject({ kind: "invalid", reason: "status-unknown" });
  });

  it("refuses a roadmap without a goal and a stage without a readable status", () => {
    expect(parseFlockRoadmap(fence('{"status":"paused"}'))).toMatchObject({
      kind: "invalid",
      reason: "goal-missing",
    });
    expect(
      parseFlockRoadmap(
        fence('{"goal":"g","stages":[{"title":"x","status":"later"}]}'),
      ),
    ).toMatchObject({ kind: "invalid", reason: "stage-invalid" });
  });

  it("refuses more than one block and a block that never closes", () => {
    expect(
      parseFlockRoadmap(`${fence('{"goal":"a"}')}\n\n${fence('{"goal":"b"}')}`),
    ).toMatchObject({ kind: "invalid", reason: "multiple-fences" });
    expect(parseFlockRoadmap('```distill-roadmap\n{"goal":"a"}')).toMatchObject(
      { kind: "invalid", reason: "unterminated-fence" },
    );
  });

  it("caps the stage list rather than refusing a long one", () => {
    const stages = Array.from({ length: MAX_ROADMAP_STAGES + 5 }, (_, i) => ({
      title: `stage ${i}`,
      status: "pending",
    }));
    const parse = parseFlockRoadmap(
      fence(JSON.stringify({ goal: "g", stages })),
    );
    expect(parse.kind).toBe("roadmap");
    if (parse.kind !== "roadmap") return;
    expect(parse.roadmap.stages).toHaveLength(MAX_ROADMAP_STAGES);
  });
});
