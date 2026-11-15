import { describe, expect, it } from "vitest";

import type { SessionNode } from "@/features/conductor/types";

import {
  buildContextTeam,
  contextWindowPressure,
  contextWindowShare,
  type ContextTeamSession,
} from "../contextTeam";

function node(
  overrides: Partial<SessionNode> & { sessionId: string },
): SessionNode {
  return {
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: null,
    rootConductorId: null,
    runId: null,
    harnessId: "claude-acp",
    displayName: overrides.sessionId,
    status: "completed",
    createdAt: 1,
    ...overrides,
  };
}

function byId(nodes: SessionNode[]): Record<string, SessionNode> {
  return Object.fromEntries(nodes.map((entry) => [entry.sessionId, entry]));
}

function resolver(sessions: ContextTeamSession[]) {
  return (id: string) =>
    sessions.find(
      (session) => session.id === id || session.clientSessionId === id,
    );
}

const summary = (team: ReturnType<typeof buildContextTeam>) =>
  team.map(
    (member) =>
      `${"  ".repeat(member.depth)}${member.sessionId}${member.isCurrent ? "*" : ""}`,
  );

describe("buildContextTeam", () => {
  const conductor = node({
    sessionId: "conductor",
    role: "conductor",
    rootConductorId: "conductor",
    displayName: "Conductor",
  });
  const integrator = node({
    sessionId: "integrator",
    parentSessionId: "conductor",
    rootConductorId: "conductor",
    harnessId: "codex-acp",
    stepIndex: 0,
    createdAt: 2,
  });
  const acceptor = node({
    sessionId: "acceptor",
    parentSessionId: "conductor",
    rootConductorId: "conductor",
    harnessId: "grok-acp",
    stepIndex: 1,
    createdAt: 3,
  });
  const reader = node({
    sessionId: "reader",
    parentSessionId: "integrator",
    rootConductorId: "conductor",
    createdAt: 4,
  });
  const nodesById = byId([conductor, integrator, acceptor, reader]);
  const noSessions = resolver([]);

  it("lists nothing for a chat that started no one and was started by no one", () => {
    expect(
      buildContextTeam({
        nodesById,
        currentIds: ["lonely"],
        resolveSession: noSessions,
      }),
    ).toEqual([]);
    expect(
      buildContextTeam({
        nodesById: {},
        currentIds: [undefined, null, ""],
        resolveSession: noSessions,
      }),
    ).toEqual([]);
  });

  it("draws the whole team under the conductor, in plan order", () => {
    const team = buildContextTeam({
      nodesById,
      currentIds: ["conductor"],
      resolveSession: noSessions,
    });
    expect(summary(team)).toEqual([
      "conductor*",
      "  integrator",
      "    reader",
      "  acceptor",
    ]);
    expect(team[0]?.name).toBe("Conductor");
    expect(team[1]?.node?.harnessId).toBe("codex-acp");
  });

  it("shows the same team from an executor's seat, marking that executor", () => {
    const fromWorker = buildContextTeam({
      nodesById,
      currentIds: ["acceptor"],
      resolveSession: noSessions,
    });
    expect(summary(fromWorker)).toEqual([
      "conductor",
      "  integrator",
      "    reader",
      "  acceptor*",
    ]);
    // Two levels down still roots at the chat nothing started.
    const fromSubagent = buildContextTeam({
      nodesById,
      currentIds: ["reader"],
      resolveSession: noSessions,
    });
    expect(summary(fromSubagent)).toEqual([
      "conductor",
      "  integrator",
      "    reader*",
      "  acceptor",
    ]);
  });

  it("roots at an ordinary chat that has no node of its own", () => {
    const helper = node({
      sessionId: "helper",
      managedBy: "agent-cli",
      parentSessionId: "plain-chat",
      rootConductorId: "plain-chat",
    });
    const sessions = resolver([
      { id: "plain-chat", title: "Audit the tokens" },
    ]);
    const fromParent = buildContextTeam({
      nodesById: byId([helper]),
      currentIds: ["plain-chat"],
      resolveSession: sessions,
    });
    expect(summary(fromParent)).toEqual(["plain-chat*", "  helper"]);
    expect(fromParent[0]?.name).toBe("Audit the tokens");
    expect(fromParent[0]?.node).toBeUndefined();

    const fromChild = buildContextTeam({
      nodesById: byId([helper]),
      currentIds: ["helper"],
      resolveSession: sessions,
    });
    expect(summary(fromChild)).toEqual(["plain-chat", "  helper*"]);
  });

  it("leaves out agents whose chats were archived, but never the open chat", () => {
    const sessions = resolver([
      { id: "conductor", title: "Conductor" },
      { id: "integrator", title: "Integrator", archivedAt: "2026-11-01" },
      { id: "acceptor", title: "Acceptor" },
    ]);
    expect(
      summary(
        buildContextTeam({
          nodesById,
          currentIds: ["conductor"],
          resolveSession: sessions,
        }),
      ),
    ).toEqual(["conductor*", "    reader", "  acceptor"]);
    // Looking at the archived agent itself still places it in its team.
    expect(
      summary(
        buildContextTeam({
          nodesById,
          currentIds: ["integrator"],
          resolveSession: sessions,
        }),
      ),
    ).toEqual(["conductor", "  integrator*", "    reader", "  acceptor"]);

    // With every agent put away, a team of one is no team.
    const allArchived = resolver([
      { id: "integrator", title: "Integrator", archivedAt: "2026-11-01" },
      { id: "acceptor", title: "Acceptor", archivedAt: "2026-11-01" },
      { id: "reader", title: "Reader", archivedAt: "2026-11-01" },
    ]);
    expect(
      buildContextTeam({
        nodesById,
        currentIds: ["conductor"],
        resolveSession: allArchived,
      }),
    ).toEqual([]);
  });

  it("finds agents registered under the id a chat had before the host confirmed it", () => {
    const early = node({
      sessionId: "early",
      parentSessionId: "client-1",
      rootConductorId: "client-1",
    });
    const sessions = resolver([
      { id: "host-1", clientSessionId: "client-1", title: "Parent" },
    ]);
    // Opened under its host id; the child still points at the client id.
    const team = buildContextTeam({
      nodesById: byId([early]),
      currentIds: ["host-1", "client-1"],
      resolveSession: sessions,
    });
    expect(summary(team)).toEqual(["host-1*", "  early"]);

    // From the child, the root resolves to the chat's real id, so its usage
    // is read and it is opened under the id the app knows it by.
    const fromChild = buildContextTeam({
      nodesById: byId([early]),
      currentIds: ["early"],
      resolveSession: sessions,
    });
    expect(summary(fromChild)).toEqual(["host-1", "  early*"]);
  });
});

describe("context window figures", () => {
  it("has no share for a window whose size was never named", () => {
    expect(contextWindowShare({ used: 12_000, limit: 0 })).toBeNull();
    expect(contextWindowPressure(null)).toBe("normal");
  });

  it("clamps the share to the window", () => {
    expect(contextWindowShare({ used: 50, limit: 200 })).toBe(0.25);
    expect(contextWindowShare({ used: 300, limit: 200 })).toBe(1);
  });

  it("raises the pressure where the operator's options change", () => {
    expect(contextWindowPressure(0.69)).toBe("normal");
    expect(contextWindowPressure(0.7)).toBe("high");
    expect(contextWindowPressure(0.89)).toBe("high");
    expect(contextWindowPressure(0.9)).toBe("critical");
  });
});
