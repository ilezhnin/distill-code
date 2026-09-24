import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode, StructuredReport } from "./types";
import { waveDigestMarker } from "./waveDigest";

const spawnConductorChildSession = vi.hoisted(() => vi.fn());
vi.mock("./spawnOrchestrator", () => ({ spawnConductorChildSession }));

/**
 * The envelope is mocked at `deliverEnvelope`, the single seam every outgoing
 * message in this feature goes through, and the mock commits what the real
 * distillctl path commits: a user message with `origin: "distillctl_cross_session"`.
 * Everything downstream of that — the verdict anchor, the re-entrancy checks,
 * the card — reads the transcript, so the tests exercise the real machinery.
 */
const deliverEnvelope = vi.hoisted(() => vi.fn());
vi.mock("./digestDelivery", () => ({
  deliverEnvelope,
  classifyDigestDispatchError: () => ({ status: "failed" as const }),
}));

/**
 * The transcript loader, mocked at the same seam the app uses. Its default
 * behaviour here is the honest worst case: it resolves without producing a
 * transcript, which is what a failed replay or an archived session looks like.
 */
const loadSessionMessages = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/features/chat/lib/sessionActivation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/chat/lib/sessionActivation")
  >()),
  loadSessionMessages,
}));

const { resetWaveRunnerForTests, runWaveEngineTick } = await import(
  "./waveRunner"
);
const { getWaveEngineState, resetWaveEngineStateCache, hasWaveTombstone } =
  await import("./waveStore");
const { stopWaveByOperator } = await import("./waveStop");
const { WAVE_VERDICT_SILENCE_SAMPLE_MS } = await import("./waveLifecycle");
const { getWaveTelemetry } = await import("./waveTelemetryStore");

const CONDUCTOR_ID = "conductor-1";

const PLAN = `Working on it.\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Find every caller","access":[]}]}\n\`\`\``;

const REVISION_PLAN = `\`\`\`distill-wave\n{"steps":[{"role":"qa","subtask":"Re-check the callers against the tests","access":"all"}]}\n\`\`\``;

/**
 * The engine remembers the newest message it has handled per conductor, so a
 * later turn has to be stamped later — as it is in life, where turns are
 * minutes apart. Starts above the fixed times the digest fixtures use.
 */
let createdClock = 1_000;

function nextCreated(): number {
  createdClock += 1_000;
  return createdClock;
}

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: nextCreated(),
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function conductorNode(): SessionNode {
  return {
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
  };
}

function report(runId: string, summary: string): StructuredReport {
  return {
    runId,
    status: "completed",
    summary,
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
  };
}

function conductorMessages(): Message[] {
  return useChatStore.getState().messagesBySession[CONDUCTOR_ID] ?? [];
}

function appendConductorMessage(message: Message): void {
  useChatStore.setState((state) => ({
    messagesBySession: {
      ...state.messagesBySession,
      [CONDUCTOR_ID]: [
        ...(state.messagesBySession[CONDUCTOR_ID] ?? []),
        message,
      ],
    },
  }));
}

function noticeTexts(): string[] {
  return conductorMessages().flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "systemNotification" ? [block.text] : [],
    ),
  );
}

function noticeActions() {
  return conductorMessages().flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "systemNotification" && block.action ? [block.action] : [],
    ),
  );
}

/** Finishes every spawned child of the live wave, with a real report. */
function completeAllSteps(summaryPrefix = "did the thing"): void {
  const graph = useConductorGraphStore.getState();
  for (const node of Object.values(graph.nodesById)) {
    if (node.role !== "worker" || !node.runId) continue;
    graph.attachReport(
      report(node.runId, `${summaryPrefix} ${node.sessionId}`),
    );
    graph.patchNode(node.sessionId, { status: "completed" });
  }
}

/** Drives the tick until the queued async deliveries have settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    runWaveEngineTick();
    await Promise.resolve();
    await Promise.resolve();
  }
}

describe("wave closed loop", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    createdClock = 1_000;
    window.localStorage.clear();
    resetWaveEngineStateCache();
    resetWaveRunnerForTests();
    spawnConductorChildSession.mockReset();
    deliverEnvelope.mockReset();
    loadSessionMessages.mockReset();
    loadSessionMessages.mockImplementation(async () => true);

    let counter = 0;
    spawnConductorChildSession.mockImplementation(async (args) => {
      counter += 1;
      const sessionId = `child-${counter}`;
      const runId = `run-${counter}`;
      useConductorGraphStore.getState().registerNode({
        sessionId,
        projectId: "project",
        role: "worker",
        managedBy: "wave",
        parentSessionId: CONDUCTOR_ID,
        rootConductorId: CONDUCTOR_ID,
        runId,
        harnessId: "goose",
        displayName: `Worker ${counter}`,
        status: "running",
        waveId: args.waveId,
        stepIndex: args.stepIndex,
        anchorMessageId: args.anchorMessageId,
      });
      return { sessionId, runId };
    });
    deliverEnvelope.mockImplementation(
      async (_sessionId: string, text: string) => {
        appendConductorMessage({
          id: `envelope-${crypto.randomUUID()}`,
          role: "user",
          created: Date.now(),
          content: [{ type: "text", text }],
          metadata: { origin: "distillctl_cross_session" },
        });
        return { status: "dispatched" as const };
      },
    );

    useChatSessionStore.setState({ hasHydratedSessions: true });
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR_ID]: [assistant("plan-1", PLAN)] },
      sessionStateById: {},
      queuedMessageBySession: {},
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());
  });

  afterEach(() => {
    resetWaveRunnerForTests();
  });

  async function runWaveToDigest(): Promise<void> {
    await settle();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    completeAllSteps();
    await settle();
  }

  it("delivers one digest and then waits for a verdict", async () => {
    await runWaveToDigest();
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    const [wave] = getWaveEngineState().waves;
    expect(wave.phase).toBe("awaitingVerdict");
    expect(deliverEnvelope.mock.calls[0][1]).toContain(
      waveDigestMarker(wave.waveId, 0),
    );
    // The step's report is flagged before the send, so a second pass — and a
    // restart in the middle of one — cannot publish it twice.
    expect(
      useConductorGraphStore.getState().getReport("run-1")?.publishedToParent,
    ).toBe(true);
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
  });

  it("closes the wave on accept and posts nothing extra", async () => {
    await runWaveToDigest();
    const noticesBefore = noticeTexts().length;
    appendConductorMessage(
      assistant(
        "verdict-1",
        'Three callers, all in src/.\n\n```distill-verdict\n{"verdict":"accept"}\n```',
      ),
    );
    await settle();
    expect(getWaveEngineState().waves).toHaveLength(0);
    // The engine record is gone; the telemetry record is what remains of it.
    const telemetry = getWaveTelemetry();
    expect(telemetry.records).toHaveLength(1);
    expect(telemetry.records[0]).toMatchObject({
      outcome: "accepted",
      stepCount: 1,
      revisionIndex: 0,
    });
    expect(telemetry.counters.admittedWaves).toBe(1);
    expect(noticeTexts()).toHaveLength(noticesBefore);
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
  });

  it("runs one revision wave that sees the previous wave's reports", async () => {
    await runWaveToDigest();
    appendConductorMessage(
      assistant(
        "verdict-1",
        `Not quite.\n\n\`\`\`distill-verdict\n{"verdict":"revise"}\n\`\`\`\n\n${REVISION_PLAN}`,
      ),
    );
    await settle();

    expect(spawnConductorChildSession).toHaveBeenCalledTimes(2);
    const revisionPrompt = spawnConductorChildSession.mock.calls[1][0].prompt;
    // Q4: the revision's `"all"` step is handed the previous wave's reports,
    // marked as coming from the previous wave rather than from a sibling step.
    expect(revisionPrompt).toContain("did the thing child-1");
    expect(revisionPrompt).toContain('"wave": "previous"');

    const [revision] = getWaveEngineState().waves;
    expect(revision.phase).toBe("running");
    expect(revision.revisionCount).toBe(1);
    // The root request identity is inherited, which is what makes the cap
    // "per root request" rather than "per wave".
    expect(revision.rootRequestId).toBe("plan-1");
  });

  it("never lets a revise verdict be admitted again as a new root wave", async () => {
    await runWaveToDigest();
    appendConductorMessage(
      assistant(
        "verdict-1",
        `\`\`\`distill-verdict\n{"verdict":"revise"}\n\`\`\`\n\n${REVISION_PLAN}`,
      ),
    );
    await settle();
    await settle();

    // Exactly one revision wave exists, and the plan detector is locked out of
    // the verdict message by the tombstone the verdict pass wrote first.
    expect(getWaveEngineState().waves).toHaveLength(1);
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(2);
    expect(hasWaveTombstone(getWaveEngineState(), "verdict-1")).toBe(true);
  });

  it("never lets the digest itself seed a wave, whatever it contains", async () => {
    await runWaveToDigest();
    // A digest is a user message; the plan detector only scans assistant
    // messages. Put a syntactically perfect plan inside one and tick hard.
    appendConductorMessage({
      id: "hostile-digest",
      role: "user",
      created: Date.now(),
      content: [
        {
          type: "text",
          text: `${waveDigestMarker("wave-x", 0)}\n${REVISION_PLAN}`,
        },
      ],
      metadata: { origin: "distillctl_cross_session" },
    });
    await settle();
    await settle();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
  });

  it("refuses a third revision and says the cap is spent", async () => {
    await runWaveToDigest();
    const reviseMessage = (id: string) =>
      assistant(
        id,
        `\`\`\`distill-verdict\n{"verdict":"revise"}\n\`\`\`\n\n${REVISION_PLAN}`,
      );

    // Revision 1.
    appendConductorMessage(reviseMessage("verdict-1"));
    await settle();
    completeAllSteps("second pass");
    await settle();
    expect(getWaveEngineState().waves[0].revisionCount).toBe(1);

    // Revision 2.
    appendConductorMessage(reviseMessage("verdict-2"));
    await settle();
    completeAllSteps("third pass");
    await settle();
    expect(getWaveEngineState().waves[0].revisionCount).toBe(2);
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(3);

    // Revision 3 is refused by the app, not by the prompt.
    appendConductorMessage(reviseMessage("verdict-3"));
    await settle();
    const wave = getWaveEngineState().waves[0];
    expect(wave.phase).toBe("needsOperator");
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(3);
    expect(noticeTexts().join("\n")).toContain("2 revisions");
  });

  it("resumes a restart mid-delivery without sending the digest twice", async () => {
    await runWaveToDigest();
    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    const wave = getWaveEngineState().waves[0];

    // Simulate a restart while the wave was still marked `dispatchingDigest`:
    // the persisted phase is ambiguous, the transcript is not.
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
    window.localStorage.setItem(
      "distill:conductor-waves",
      JSON.stringify({
        version: 2,
        waves: [{ ...wave, phase: "dispatchingDigest" }],
        tombstones: getWaveEngineState().tombstones,
      }),
    );
    resetWaveEngineStateCache();
    await settle();

    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
  });

  /**
   * C2. `chat.messagesBySession` is an LRU cache, not a record: it starts
   * empty, is filled only by activation or by a send, and is evicted past ten
   * sessions. The lifecycle runs with the conductor chat shut, so "the digest
   * is not in the transcript" and "the transcript was never read" are the same
   * observation — and treating the second as the first re-sends the digest.
   */
  describe("a conductor transcript that was never loaded", () => {
    /** Restarts the process with the wave persisted mid-delivery. */
    function restartMidDelivery(wave: {
      waveId: string;
      conductorSessionId: string;
    }): void {
      resetWaveRunnerForTests();
      window.localStorage.setItem(
        "distill:conductor-waves",
        JSON.stringify({
          version: 2,
          waves: [{ ...wave, phase: "dispatchingDigest" }],
          tombstones: getWaveEngineState().tombstones,
        }),
      );
      resetWaveEngineStateCache();
      // The operator relaunched into some other chat: nothing has loaded this
      // conductor's messages, so the store holds no entry for it at all.
      useChatStore.setState({ messagesBySession: {} });
    }

    it("never re-delivers a digest on the strength of an unread transcript", async () => {
      await runWaveToDigest();
      const wave = getWaveEngineState().waves[0];
      const digestText = deliverEnvelope.mock.calls[0][1];
      restartMidDelivery(wave);

      await settle();

      // The digest did land before the restart; a second copy would be two
      // model turns, and `findDigestMessageIndex` takes the *last* match, so
      // the answer to the first copy would simply be discarded.
      expect(deliverEnvelope).toHaveBeenCalledTimes(1);
      expect(getWaveEngineState().waves[0].phase).toBe("dispatchingDigest");
      // It asked for the transcript rather than guessing.
      expect(loadSessionMessages).toHaveBeenCalledWith(CONDUCTOR_ID);

      // Once the transcript actually arrives and the digest is in it, the wave
      // moves on — still on one delivery.
      useChatStore.setState({
        messagesBySession: {
          [CONDUCTOR_ID]: [
            assistant("plan-1", PLAN),
            {
              id: "digest-1",
              role: "user",
              created: 2,
              content: [{ type: "text", text: digestText }],
            },
          ],
        },
      });
      await settle();
      expect(deliverEnvelope).toHaveBeenCalledTimes(1);
      expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
    });
  });

  it("does not re-park a wave the operator stopped inside the delivery window", async () => {
    // The stop now reaches `dispatchingDigest`. A send that then fails used to
    // append a second closure notice — with a retry button that would
    // re-digest a wave whose children are already dead — and `recordWaveClose`
    // upserted over the `operator-stopped` reason, so the telemetry record
    // forgot the stop.
    let failDelivery!: () => void;
    deliverEnvelope.mockImplementation(
      () =>
        new Promise((resolve) => {
          failDelivery = () =>
            resolve({ status: "failed" as const, detail: "bridge gone" });
        }),
    );
    await settle();
    completeAllSteps();
    await settle();
    const waveId = getWaveEngineState().waves[0].waveId;
    expect(getWaveEngineState().waves[0].phase).toBe("dispatchingDigest");

    await stopWaveByOperator(CONDUCTOR_ID, waveId);
    await settle();
    const noticesAfterStop = noticeTexts().length;
    expect(getWaveEngineState().waves[0].phase).toBe("needsOperator");

    failDelivery();
    await settle();

    expect(noticeTexts()).toHaveLength(noticesAfterStop);
    expect(noticeActions()).not.toContainEqual({
      type: "retryWaveDigest",
      sessionId: CONDUCTOR_ID,
      waveId,
    });
    // The record still says the operator stopped it.
    const record = getWaveTelemetry().records.find(
      (candidate) => candidate.waveId === waveId,
    );
    expect(record?.closureReason).toBe("operator-stopped");
  });

  describe("a verdict that is never coming", () => {
    /** Pins the clock so the silence samples can be stepped by hand. */
    function pinClock(): {
      advance: (ms: number) => void;
      restore: () => void;
    } {
      let now = 10_000;
      const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
      return {
        advance: (ms: number) => {
          now += ms;
        },
        restore: () => spy.mockRestore(),
      };
    }

    it("parks the wave when the digest reached neither the transcript nor the queue", async () => {
      // The digest was queued because the conductor was busy and the queue was
      // then cleared (or the session went away). Nothing will ever answer it,
      // and the wave used to stay live for the rest of the session — refusing
      // every later plan the conductor made as concurrent.
      deliverEnvelope.mockImplementation(async () => ({
        status: "queued" as const,
      }));
      const clock = pinClock();
      try {
        await runWaveToDigest();
        expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");

        // One sample decides nothing: the healthy path looks exactly like this
        // for the moment between the queue draining and the message landing.
        await settle();
        expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");

        clock.advance(WAVE_VERDICT_SILENCE_SAMPLE_MS + 1);
        await settle();
        const [wave] = getWaveEngineState().waves;
        expect(wave.phase).toBe("needsOperator");
        // No revision spent, and the operator can re-ask — WAVES: an
        // undecided wave MUST offer the ability to ask again.
        expect(wave.revisionCount).toBe(0);
        expect(noticeTexts().join("\n")).toContain(
          i18n.t("chat:conductor.wave.verdict.reason.digestLost"),
        );
        expect(noticeActions()).toContainEqual({
          type: "retryWaveDigest",
          sessionId: CONDUCTOR_ID,
          waveId: wave.waveId,
        });
      } finally {
        clock.restore();
      }
    });

    it("waits while the digest is still in the conductor's queue", async () => {
      const digests: string[] = [];
      deliverEnvelope.mockImplementation(
        async (_sessionId: string, text: string) => {
          digests.push(text);
          useChatStore.setState({
            queuedMessageBySession: {
              [CONDUCTOR_ID]: [
                {
                  id: "queued-1",
                  kind: "transport-ready",
                  payload: { text },
                } as never,
              ],
            },
          });
          return { status: "queued" as const };
        },
      );
      const clock = pinClock();
      try {
        await runWaveToDigest();
        clock.advance(WAVE_VERDICT_SILENCE_SAMPLE_MS * 5);
        await settle();
        // Still on its way: the queue drains when the conductor frees.
        expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
        expect(digests).toHaveLength(1);
      } finally {
        clock.restore();
      }
    });

    it("parks the wave when the conductor's turn on the digest ended without an answer", async () => {
      const clock = pinClock();
      try {
        await runWaveToDigest();
        const [delivered] = getWaveEngineState().waves;
        expect(delivered.phase).toBe("awaitingVerdict");

        // While the conductor is working, silence is just work in progress.
        useChatStore.getState().setChatState(CONDUCTOR_ID, "thinking");
        clock.advance(WAVE_VERDICT_SILENCE_SAMPLE_MS * 4);
        await settle();
        expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");

        // Its turn then ends in an error notice with no answer in it.
        useChatStore.getState().setChatState(CONDUCTOR_ID, "error");
        await settle();
        expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
        clock.advance(WAVE_VERDICT_SILENCE_SAMPLE_MS + 1);
        await settle();

        const [wave] = getWaveEngineState().waves;
        expect(wave.phase).toBe("needsOperator");
        expect(noticeTexts().join("\n")).toContain(
          i18n.t("chat:conductor.wave.verdict.reason.verdictUnanswered"),
        );
        expect(noticeActions()).toContainEqual({
          type: "retryWaveDigest",
          sessionId: CONDUCTOR_ID,
          waveId: wave.waveId,
        });
        // The digest was not sent again behind the operator's back.
        expect(deliverEnvelope).toHaveBeenCalledTimes(1);
      } finally {
        clock.restore();
      }
    });
  });

  it("drops a parked wave when the conductor starts a new root request", async () => {
    await runWaveToDigest();
    appendConductorMessage(assistant("verdict-1", "no fence"));
    await settle();
    expect(getWaveEngineState().waves[0].phase).toBe("needsOperator");

    appendConductorMessage(assistant("plan-2", PLAN));
    await settle();
    const waves = getWaveEngineState().waves;
    expect(waves).toHaveLength(1);
    expect(waves[0].planMessageId).toBe("plan-2");
    expect(waves[0].revisionCount).toBe(0);
  });
});
