import { beforeEach, describe, expect, it, vi } from "vitest";

import { useChatStore } from "@/features/chat/stores/chatStore";
import type { Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import { processRoadmaps, resetRoadmapSyncForTests } from "./roadmapSync";
import { emptyWaveEngineState } from "./waveStore";

const CONDUCTOR_ID = "conductor-1";

const ROADMAP =
  '```distill-roadmap\n{"goal":"Ship the editor","status":"in-progress","stages":[{"title":"Callers","status":"active"},{"title":"Assets","status":"pending"}]}\n```';

function reply(id: string, created: number, text = ROADMAP): Message {
  return {
    id,
    role: "assistant",
    created,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function setTranscript(messages: readonly Message[]): void {
  useChatStore.setState({
    messagesBySession: { [CONDUCTOR_ID]: [...messages] },
  });
}

describe("processRoadmaps", () => {
  beforeEach(() => {
    resetRoadmapSyncForTests();
    useChatStore.setState({ messagesBySession: {} });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode({
      sessionId: CONDUCTOR_ID,
      projectId: "project",
      role: "conductor",
      managedBy: "ui",
      parentSessionId: null,
      rootConductorId: CONDUCTOR_ID,
      runId: null,
      harnessId: "goose",
      displayName: "Producer",
      status: "stopped",
    });
  });

  it("does not announce a roadmap again when its own message is read again later-stamped", () => {
    // A reply read again from the log carries the time of its last piece,
    // later than the time it had while it streamed. Compared by time alone,
    // the roadmap's own message was newer than the roadmap, and every
    // restart announced an unchanged roadmap to the conductor's chat.
    const notify = vi.fn();
    setTranscript([reply("reply-1", 1_000)]);
    const read = processRoadmaps(emptyWaveEngineState(), notify);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(read.roadmaps[CONDUCTOR_ID]?.sourceMessageId).toBe("reply-1");

    // The next sitting: nothing remembered in memory, the same reply back
    // from the log.
    resetRoadmapSyncForTests();
    setTranscript([reply("reply-1", 61_000)]);
    const again = processRoadmaps(read, notify);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(again).toBe(read);
  });

  it("knows the roadmap's message under the id its agent gave it", () => {
    const notify = vi.fn();
    setTranscript([reply("msg_1", 1_000)]);
    const read = processRoadmaps(emptyWaveEngineState(), notify);

    resetRoadmapSyncForTests();
    setTranscript([
      {
        ...reply("host-reply-1", 61_000),
        metadata: {
          completionStatus: "completed",
          agentMessageIds: ["msg_1"],
        },
      },
    ]);
    expect(processRoadmaps(read, notify)).toBe(read);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("still reads a newer roadmap from a later message", () => {
    const notify = vi.fn();
    setTranscript([reply("reply-1", 1_000)]);
    const read = processRoadmaps(emptyWaveEngineState(), notify);

    const reached = ROADMAP.replace("in-progress", "reached");
    setTranscript([reply("reply-1", 1_000), reply("reply-2", 2_000, reached)]);
    const next = processRoadmaps(read, notify);

    expect(next.roadmaps[CONDUCTOR_ID]).toMatchObject({
      status: "reached",
      sourceMessageId: "reply-2",
    });
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
