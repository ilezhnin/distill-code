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
  it("never produces a name that is a path", () => {
    // The native side refuses one anyway; producing one would just mean the
    // closeout is silently never written.
    const name = closeoutFileName("../../etc/passwd", AT);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name.endsWith(".md")).toBe(true);
  });
});

describe("buildRunCloseout", () => {
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
