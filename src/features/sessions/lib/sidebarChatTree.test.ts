import { describe, expect, it } from "vitest";

import { indexAgentChildren } from "@/features/conductor/agentTree";
import type { SessionNode } from "@/features/conductor/types";
import type { SidebarSessionItem } from "@/features/sessions/ui/session-list/SidebarProjectSection";

import { childChatItems, isAgentChatBusy } from "./sidebarChatTree";

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "parent",
    rootConductorId: "parent",
    runId: null,
    harnessId: "harness",
    displayName: `Agent ${overrides.sessionId}`,
    status: "completed",
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function item(id: string, extra: Partial<SidebarSessionItem> = {}) {
  return {
    id,
    title: `Chat ${id}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    activityAt: "2026-01-02T00:00:00.000Z",
    isRunning: false,
    hasUnread: false,
    ...extra,
  } satisfies SidebarSessionItem;
}

describe("childChatItems", () => {
  it("uses the loaded chat for a child and the node for one that is not loaded", () => {
    const forest = indexAgentChildren({
      loaded: node({ sessionId: "loaded", status: "waiting" }),
      unloaded: node({
        sessionId: "unloaded",
        status: "running",
        createdAt: 1_700_000_000_000,
        finishedAt: undefined,
      }),
    }).forestUnder(["parent"]);
    const items = childChatItems(forest, (id) =>
      id === "loaded" ? item("loaded", { hasUnread: true }) : undefined,
    );
    expect(items).toEqual([
      item("loaded", { hasUnread: true }),
      {
        id: "unloaded",
        title: "Agent unloaded",
        updatedAt: "2023-11-14T22:13:20.000Z",
        activityAt: "2023-11-14T22:13:20.000Z",
        projectId: "project",
        isRunning: true,
        hasUnread: false,
      },
    ]);
  });

  it("marks a child running when its chat streams or its agent is busy", () => {
    const forest = indexAgentChildren({
      streaming: node({
        sessionId: "streaming",
        status: "completed",
        createdAt: 1,
      }),
      starting: node({
        sessionId: "starting",
        status: "starting",
        createdAt: 2,
      }),
      waiting: node({ sessionId: "waiting", status: "waiting", createdAt: 3 }),
    }).forestUnder(["parent"]);
    const items = childChatItems(forest, (id) =>
      item(id, { isRunning: id === "streaming" }),
    );
    expect(items.map((entry) => [entry.id, entry.isRunning])).toEqual([
      ["streaming", true],
      ["starting", true],
      ["waiting", false],
    ]);
  });

  it("nests grandchildren under their parent row", () => {
    const forest = indexAgentChildren({
      orchestrator: node({ sessionId: "orchestrator", role: "orchestrator" }),
      worker: node({ sessionId: "worker", parentSessionId: "orchestrator" }),
    }).forestUnder(["parent"]);
    const items = childChatItems(forest, (id) => item(id));
    expect(items).toHaveLength(1);
    expect(items[0]?.children?.map((entry) => entry.id)).toEqual(["worker"]);
    expect(items[0]?.children?.[0]?.children).toBeUndefined();
  });

  it("drops an archived child with its subtree unless something in it still works", () => {
    const forest = indexAgentChildren({
      "quiet-archived": node({ sessionId: "quiet-archived" }),
      "quiet-worker": node({
        sessionId: "quiet-worker",
        parentSessionId: "quiet-archived",
      }),
      "busy-archived": node({ sessionId: "busy-archived" }),
      "busy-worker": node({
        sessionId: "busy-worker",
        parentSessionId: "busy-archived",
        status: "running",
      }),
    }).forestUnder(["parent"]);
    const items = childChatItems(forest, (id) =>
      id.endsWith("-archived") ? "archived" : item(id),
    );
    expect(items.map((entry) => entry.id)).toEqual(["busy-archived"]);
    expect(items[0]?.title).toBe("Agent busy-archived");
    expect(items[0]?.children?.map((entry) => entry.id)).toEqual([
      "busy-worker",
    ]);
  });

  it("treats only a starting or running agent as busy", () => {
    expect(isAgentChatBusy("starting")).toBe(true);
    expect(isAgentChatBusy("running")).toBe(true);
    expect(isAgentChatBusy("waiting")).toBe(false);
    expect(isAgentChatBusy("completed")).toBe(false);
    expect(isAgentChatBusy("failed")).toBe(false);
  });
});
