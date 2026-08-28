import { describe, expect, it } from "vitest";

import { buildRunCloseout, closeoutFileName } from "./runCloseout";
import { closesTheRootRequest } from "./runCloseoutWriter";
import type { StructuredReport } from "./types";
import type { WaveTelemetryRecord } from "./waveTelemetryStore";

const AT = Date.UTC(2026, 7, 29, 10, 0, 0);

function report(over: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "r1",
    status: "completed",
    summary: "Renamed the flag everywhere",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...over,
  };
}

function wave(over: Partial<WaveTelemetryRecord> = {}): WaveTelemetryRecord {
  return {
    waveId: "w1",
    conductorSessionId: "c1",
    rootRequestId: "root",
    revisionIndex: 0,
    createdAt: AT - 60_000,
    closedAt: AT,
    durationMs: 60_000,
    outcome: "accepted",
    digestAttempt: 0,
    stepCount: 1,
    degradedStepCount: 0,
    steps: [
      {
        stepIndex: 0,
        role: "brigade",
        access: "none",
        outcome: "completed",
        reportDegraded: false,
      },
    ],
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildRunCloseout>[0]> = {}) {
  return buildRunCloseout({
    waves: [wave()],
    title: "Rename the flag",
    at: AT,
    reportOf: () => report(),
    runIdOf: () => "r1",
    ...over,
  });
}

describe("closeoutFileName", () => {
  it("dates it and slugs the title", () => {
    expect(closeoutFileName("Rename the flag!", AT)).toBe(
      "2026-08-29-rename-the-flag.md",
    );
  });

  it("never produces a name that is a path", () => {
    // The native side refuses one anyway; producing one would just mean the
    // closeout is silently never written.
    const name = closeoutFileName("../../etc/passwd", AT);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.endsWith(".md")).toBe(true);
  });

  it("still names a run whose title has nothing sluggable in it", () => {
    expect(closeoutFileName("!!!", AT)).toBe("2026-08-29-run.md");
  });
});

describe("buildRunCloseout", () => {
  it("says what the run did, and what it ended as", () => {
    const text = build();
    expect(text).toContain("# Rename the flag");
    expect(text).toContain("1 wave");
    expect(text).toContain("accepted");
    expect(text).toContain("Renamed the flag everywhere");
  });

  it("omits a section rather than leaving it empty", () => {
    // A heading with nothing under it reads as "we looked and found nothing",
    // which is a different claim from "this run produced none of that".
    const text = build();
    expect(text).not.toContain("## Risks left open");
    expect(text).not.toContain("## Decisions");
  });

  it("collects the decisions, files and risks the reports carried", () => {
    const text = build({
      reportOf: () =>
        report({
          decisions: ["Kept the old name as an alias"],
          artifacts: [{ label: "config", path: "src/config.ts" }],
          risks: ["Docs still say enableFoo"],
        }),
    });
    expect(text).toContain("- Kept the old name as an alias");
    expect(text).toContain("- src/config.ts");
    expect(text).toContain("- Docs still say enableFoo");
  });

  it("gives a revision its own heading", () => {
    const text = build({
      waves: [
        wave({ waveId: "w1", outcome: "revised" }),
        wave({ waveId: "w2", revisionIndex: 1, createdAt: AT }),
      ],
    });
    expect(text).toContain("## What was done");
    expect(text).toContain("## Revision 1");
    expect(text).toContain("2 waves");
  });

  it("says where it came from, so nobody reads it as a model's own account", () => {
    expect(build()).toContain("not from a model asked to summarize its own");
  });

  it("carries the operator's request when it is known", () => {
    expect(build({ request: "rename enableFoo to enableBar" })).toContain(
      "rename enableFoo to enableBar",
    );
  });
});

describe("closesTheRootRequest", () => {
  it("is the end only when the request is actually over", () => {
    expect(closesTheRootRequest("accepted")).toBe(true);
    expect(closesTheRootRequest("needs-operator")).toBe(true);
    // A revision is followed by another wave; a pruned wave has nothing to
    // record that the transcript does not already say better.
    expect(closesTheRootRequest("revised")).toBe(false);
    expect(closesTheRootRequest("pruned")).toBe(false);
  });
});
