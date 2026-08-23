import { describe, expect, it } from "vitest";

import {
  brigadeWaitIndicator,
  isSessionRunning,
  isWorkingStatus,
  summarizeBrigadeActivity,
} from "./brigadeActivity";
import type { SessionNode } from "./types";

function node(
  sessionId: string,
  status: SessionNode["status"],
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status,
    ...overrides,
  };
}

describe("isWorkingStatus", () => {
  it("treats starting/running/waiting as working and the rest as terminal", () => {
    expect(isWorkingStatus("starting")).toBe(true);
    expect(isWorkingStatus("running")).toBe(true);
    expect(isWorkingStatus("waiting")).toBe(true);
    expect(isWorkingStatus("completed")).toBe(false);
    expect(isWorkingStatus("failed")).toBe(false);
    expect(isWorkingStatus("cancelled")).toBe(false);
    expect(isWorkingStatus("stopped")).toBe(false);
  });
});

describe("summarizeBrigadeActivity", () => {
  it("tallies working and completed children", () => {
    expect(
      summarizeBrigadeActivity([
        node("a", "running"),
        node("b", "waiting"),
        node("c", "completed"),
        node("d", "failed"),
      ]),
    ).toEqual({ working: 2, done: 1 });
  });

  it("returns zeroes for an empty brigade", () => {
    expect(summarizeBrigadeActivity([])).toEqual({ working: 0, done: 0 });
  });
});

describe("isSessionRunning", () => {
  it("counts every non-idle, non-error chat state as running", () => {
    expect(isSessionRunning("thinking")).toBe(true);
    expect(isSessionRunning("streaming")).toBe(true);
    expect(isSessionRunning("waiting")).toBe(true);
    expect(isSessionRunning("compacting")).toBe(true);
    expect(isSessionRunning("idle")).toBe(false);
    expect(isSessionRunning("error")).toBe(false);
  });
});

describe("brigadeWaitIndicator", () => {
  it("shows the working count when the session is idle and children work", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "idle",
        children: [
          node("a", "running"),
          node("b", "starting"),
          node("c", "waiting"),
          node("d", "completed"),
        ],
      }),
    ).toEqual({ visible: true, workingCount: 3 });
  });

  it("counts children of any managedBy and either executor role", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "idle",
        children: [
          node("ui", "running", { managedBy: "ui", role: "orchestrator" }),
          node("wave", "running", { managedBy: "wave" }),
          node("cli", "starting", { managedBy: "agent-cli" }),
        ],
      }),
    ).toEqual({ visible: true, workingCount: 3 });
  });

  it("hides while the session itself is running", () => {
    for (const chatState of [
      "thinking",
      "streaming",
      "waiting",
      "compacting",
    ] as const) {
      expect(
        brigadeWaitIndicator({
          chatState,
          children: [node("a", "running")],
        }),
      ).toEqual({ visible: false, workingCount: 1 });
    }
  });

  it("hides when every child reached a terminal status", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "idle",
        children: [
          node("a", "completed"),
          node("b", "failed"),
          node("c", "cancelled"),
          node("d", "stopped"),
        ],
      }),
    ).toEqual({ visible: false, workingCount: 0 });
  });

  it("hides when the session has no children", () => {
    expect(brigadeWaitIndicator({ chatState: "idle", children: [] })).toEqual({
      visible: false,
      workingCount: 0,
    });
  });

  it("still shows after the session's own turn errored out", () => {
    expect(
      brigadeWaitIndicator({
        chatState: "error",
        children: [node("a", "running")],
      }),
    ).toEqual({ visible: true, workingCount: 1 });
  });
});
