/**
 * One notice for a reply that holds a protocol block the app did not read:
 * for a memory request, a recall question and a roadmap as for a plan.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useConductorGraphStore } from "@/features/conductor/conductorGraphStore";
import {
  processRoadmaps,
  resetRoadmapSyncForTests,
} from "@/features/conductor/roadmapSync";
import { emptyWaveEngineState } from "@/features/conductor/waveStore";
import { detectMemoryFenceCandidates } from "@/features/memory/lib/memoryAgentScan";
import { detectRecallFenceCandidates } from "@/features/memory/lib/memoryRecall";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { UnreadProtocolBlockReason } from "@/shared/lib/protocolFences";
import type { Message } from "@/shared/types/messages";

import {
  announceUnreadProtocolBlock,
  resetUnreadProtocolBlockNoticesForTests,
} from "./unreadProtocolBlockNotice";

const SESSION = "chat-1";

function reply(id: string, text: string, created = 5_000): Message {
  return {
    id,
    role: "assistant",
    created,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function notices(sessionId = SESSION): string[] {
  return (useChatStore.getState().messagesBySession[sessionId] ?? []).flatMap(
    (message) =>
      message.content.flatMap((block) =>
        block.type === "systemNotification" ? [block.text] : [],
      ),
  );
}

describe("the notice for an unread protocol block", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    await i18n.changeLanguage("en");
    resetUnreadProtocolBlockNoticesForTests(1_000);
    useChatStore.setState({ messagesBySession: {} });
  });

  afterEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("is posted once per reply, and never for a reply older than this app run", () => {
    const post = (messageId: string, created: number) =>
      announceUnreadProtocolBlock({
        sessionId: SESSION,
        messageId,
        created,
        kind: "memory",
        reason: "list",
      });
    expect(post("reply-1", 5_000)).not.toBeNull();
    expect(post("reply-1", 5_000)).toBeNull();
    expect(post("old-reply", 500)).toBeNull();
    expect(notices()).toEqual([
      "A request to remember in this reply was not read: it is inside a list.",
    ]);
  });

  it("speaks the operator's language", async () => {
    await i18n.changeLanguage("es");
    announceUnreadProtocolBlock({
      sessionId: SESSION,
      messageId: "reply-es",
      created: 5_000,
      kind: "plan",
      reason: "quote",
      followUp: "asked",
    });
    expect(notices()).toEqual([
      "Un plan de ola de esta respuesta no se leyó: está dentro de una cita. Se pidió una vez al conductor que lo vuelva a enviar como un bloque propio.",
    ]);
  });

  it("is reported by the memory scan for a request the reader did not take", () => {
    const unread: Array<[string, string, UnreadProtocolBlockReason]> = [];
    const messages = [
      reply(
        "in-list",
        '- Keep this:\n  ```distill-memory\n  {"remember":["The build uses pnpm."]}\n  ```',
      ),
      reply(
        "own",
        '```distill-memory\n{"remember":["The build uses pnpm."]}\n```',
      ),
      reply("prose", "Nothing to keep."),
    ];
    const candidates = detectMemoryFenceCandidates({
      messagesBySession: { [SESSION]: messages },
      isApplied: () => false,
      onUnread: (sessionId, message, reason) =>
        unread.push([sessionId, message.id, reason]),
    });
    expect(candidates.map((candidate) => candidate.messageId)).toEqual(["own"]);
    expect(unread).toEqual([[SESSION, "in-list", "list"]]);
  });

  it("is reported by the recall scan for a question the reader did not take", () => {
    const unread: Array<[string, UnreadProtocolBlockReason]> = [];
    const candidates = detectRecallFenceCandidates({
      messagesBySession: {
        [SESSION]: [
          reply(
            "quoted",
            '> ```distill-recall\n> {"query":"build tool","scope":"project"}\n> ```',
          ),
        ],
      },
      isAnswered: () => false,
      onUnread: (_sessionId, message, reason) =>
        unread.push([message.id, reason]),
    });
    expect(candidates).toEqual([]);
    expect(unread).toEqual([["quoted", "quote"]]);
  });

  it("is posted for a roadmap the conductor wrote inside another code block", () => {
    resetRoadmapSyncForTests();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode({
      sessionId: SESSION,
      projectId: "project",
      role: "conductor",
      managedBy: "ui",
      parentSessionId: null,
      rootConductorId: SESSION,
      runId: null,
      harnessId: "goose",
      displayName: "Producer",
      status: "stopped",
    });
    useChatStore.setState({
      messagesBySession: {
        [SESSION]: [
          reply(
            "roadmap",
            '````markdown\n```distill-roadmap\n{"goal":"Ship","status":"in-progress","stages":[]}\n```\n````',
          ),
        ],
      },
    });
    const state = processRoadmaps(emptyWaveEngineState(), () => undefined);
    processRoadmaps(state, () => undefined);
    expect(state.roadmaps[SESSION]).toBeUndefined();
    expect(notices()).toEqual([
      "A roadmap in this reply was not read: it is inside another code block.",
    ]);
  });
});
