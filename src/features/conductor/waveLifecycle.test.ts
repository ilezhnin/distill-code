import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import type { GitState } from "@/shared/types/git";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode, StructuredReport } from "./types";
import { waveDigestMarker } from "./waveDigest";
import { setWaveGitProbeIoForTests } from "./waveGitProbe";

const spawnConductorChildSession = vi.hoisted(() => vi.fn());
vi.mock("./spawnOrchestrator", () => ({ spawnConductorChildSession }));

/**
 * The envelope is mocked at `deliverEnvelope`, the single seam every outgoing
 * message in this feature goes through, and the mock commits what the real
 * berdctl path commits: a user message with `origin: "berdctl_cross_session"`.
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
const { retryWaveDigest } = await import("./waveRetry");

const CONDUCTOR_ID = "conductor-1";

const PLAN = `Working on it.\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Find every caller","access":[]}]}\n\`\`\``;
/** A two-step plan: one worker, then a step that waits for its report. */
const TWO_STEP = `Working on it.\n\n\`\`\`distill-wave\n{"steps":[{"role":"scout","subtask":"Find every caller","access":[]},{"role":"qa","subtask":"Write the test plan","access":"all"}]}\n\`\`\``;

const REVISION_PLAN = `\`\`\`distill-wave\n{"steps":[{"role":"qa","subtask":"Re-check the callers against the tests","access":"all"}]}\n\`\`\``;

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
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
          metadata: { origin: "berdctl_cross_session" },
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

  it("waits for the app's git probe and quotes its measurement in the digest (E3a)", async () => {
    // A Tauri-like build: probes can run, and git answers only when told to,
    // so the test can watch the wave hold its digest for the measurement.
    const gitAnswers: Array<(state: GitState) => void> = [];
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: () =>
        new Promise<GitState>((resolve) => {
          gitAnswers.push(resolve);
        }),
    });
    useChatSessionStore.setState({
      sessions: [
        {
          id: CONDUCTOR_ID,
          title: "Conductor",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          messageCount: 0,
          workingDir: "/repo",
        },
      ],
    });
    const gitState = (dirtyFileCount: number): GitState => ({
      isGitRepo: true,
      currentBranch: "main",
      dirtyFileCount,
      incomingCommitCount: 0,
      worktrees: [],
      isWorktree: false,
      mainWorktreePath: null,
      localBranches: [],
    });

    await settle();
    // The admission baseline was requested when the plan was admitted.
    expect(gitAnswers).toHaveLength(1);
    gitAnswers[0](gitState(2));
    completeAllSteps();
    await settle();

    // The wave finished, but its digest waits for the app's own measurement.
    expect(gitAnswers).toHaveLength(2);
    expect(deliverEnvelope).not.toHaveBeenCalled();
    expect(getWaveEngineState().waves[0].phase).toBe("digestPending");

    gitAnswers[1](gitState(5));
    await settle();

    expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    const digestText = deliverEnvelope.mock.calls[0][1] as string;
    expect(digestText).toContain("APP MEASUREMENT");
    expect(digestText).toContain("against 2 when the wave was admitted");
    expect(digestText).toContain("(+3)");
    expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
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
      metadata: { origin: "berdctl_cross_session" },
    });
    await settle();
    await settle();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
  });

  it("stops at needsOperator when the conductor answers with no verdict (Q5)", async () => {
    await runWaveToDigest();
    appendConductorMessage(
      assistant("verdict-1", "Nice work everyone, I think that's it."),
    );
    await settle();

    const [wave] = getWaveEngineState().waves;
    expect(wave.phase).toBe("needsOperator");
    // No revision was spent on an answer that could not be read.
    expect(wave.revisionCount).toBe(0);
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(noticeActions()).toContainEqual({
      type: "retryWaveDigest",
      sessionId: CONDUCTOR_ID,
      waveId: wave.waveId,
    });
  });

  it("stops at needsOperator on an unreadable verdict, with the reason", async () => {
    await runWaveToDigest();
    appendConductorMessage(
      assistant(
        "verdict-1",
        '```distill-verdict\n{"verdict":"looks-good"}\n```',
      ),
    );
    await settle();
    expect(getWaveEngineState().waves[0].phase).toBe("needsOperator");
    expect(noticeTexts().join("\n")).toContain("looks-good");
  });

  it("re-delivers the digest under a new marker when the operator retries", async () => {
    await runWaveToDigest();
    appendConductorMessage(assistant("verdict-1", "no fence at all"));
    await settle();
    const waveId = getWaveEngineState().waves[0].waveId;

    retryWaveDigest(CONDUCTOR_ID, waveId);
    await settle();

    expect(deliverEnvelope).toHaveBeenCalledTimes(2);
    expect(deliverEnvelope.mock.calls[1][1]).toContain(
      waveDigestMarker(waveId, 1),
    );
    const wave = getWaveEngineState().waves[0];
    expect(wave.phase).toBe("awaitingVerdict");
    expect(wave.digestAttempt).toBe(1);

    // The answer to the *new* digest is what gets judged; the old one is not
    // re-read, because the anchor moved with the marker.
    appendConductorMessage(
      assistant("verdict-2", '```distill-verdict\n{"verdict":"accept"}\n```'),
    );
    await settle();
    expect(getWaveEngineState().waves).toHaveLength(0);
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
      "goose:conductor-waves",
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

  it("re-sends a digest that was lost before it reached the transcript", async () => {
    await runWaveToDigest();
    const wave = getWaveEngineState().waves[0];

    // Same restart, but this time the transcript has no digest in it: the
    // delivery never landed, so it has to be attempted again.
    resetWaveRunnerForTests();
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR_ID]: [assistant("plan-1", PLAN)] },
    });
    window.localStorage.setItem(
      "goose:conductor-waves",
      JSON.stringify({
        version: 2,
        waves: [{ ...wave, phase: "dispatchingDigest" }],
        tombstones: getWaveEngineState().tombstones,
      }),
    );
    resetWaveEngineStateCache();
    await settle();

    expect(deliverEnvelope).toHaveBeenCalledTimes(2);
  });

  it("parks the wave when the digest cannot be delivered at all", async () => {
    deliverEnvelope.mockResolvedValue({
      status: "failed" as const,
      detail: 'No session "conductor-1".',
    });
    await runWaveToDigest();
    await settle();

    expect(getWaveEngineState().waves[0].phase).toBe("needsOperator");
    const notices = noticeTexts().join("\n");
    // The reports are already flagged published, so the notice must carry the
    // digest itself or the run is simply lost.
    expect(notices).toContain("did the thing child-1");
    expect(notices).toContain('No session "conductor-1".');
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
        "goose:conductor-waves",
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

    it("re-delivers once the transcript is read and the digest is genuinely absent", async () => {
      await runWaveToDigest();
      const wave = getWaveEngineState().waves[0];
      restartMidDelivery(wave);
      // This time the delivery really was lost, and hydration is what proves
      // it: the loader returns the transcript, and there is no digest in it.
      loadSessionMessages.mockImplementation(async () => {
        useChatStore.setState({
          messagesBySession: { [CONDUCTOR_ID]: [assistant("plan-1", PLAN)] },
        });
        return true;
      });

      await settle();

      expect(deliverEnvelope).toHaveBeenCalledTimes(2);
      expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
    });

    it("closes a wave waiting on a verdict with the conductor chat shut", async () => {
      await runWaveToDigest();
      const digestText = deliverEnvelope.mock.calls[0][1];
      const wave = getWaveEngineState().waves[0];
      expect(wave.phase).toBe("awaitingVerdict");

      // Restart with the wave already waiting: without hydration the verdict
      // scan finds no digest index, forever, and the wave never closes unless
      // the operator happens to open that chat.
      resetWaveRunnerForTests();
      window.localStorage.setItem(
        "goose:conductor-waves",
        JSON.stringify({
          version: 2,
          waves: [wave],
          tombstones: getWaveEngineState().tombstones,
        }),
      );
      resetWaveEngineStateCache();
      useChatStore.setState({ messagesBySession: {} });
      loadSessionMessages.mockImplementation(async () => {
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
              assistant(
                "verdict-1",
                'Done.\n\n```distill-verdict\n{"verdict":"accept"}\n```',
              ),
            ],
          },
        });
        return true;
      });

      await settle();

      expect(getWaveEngineState().waves).toHaveLength(0);
      expect(deliverEnvelope).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * C3. The startup reconcile demotes every child whose runtime died with the
   * process to `stopped`, which `isTerminalRunStatus` calls terminal — so a
   * wave interrupted mid-flight looks exactly like a finished one, except that
   * not one step ever reported.
   */
  describe("a wave interrupted before any step reported", () => {
    it("parks on needsOperator instead of digesting a page of unknowns", async () => {
      await settle();
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

      // What the reconcile does on the next launch: no runtime, no queued
      // send, so the working child is demoted. No report was ever attached.
      const graph = useConductorGraphStore.getState();
      for (const node of Object.values(graph.nodesById)) {
        if (node.role !== "worker") continue;
        graph.patchNode(node.sessionId, { status: "stopped" });
      }
      await settle();

      // No model call was spent judging nothing.
      expect(deliverEnvelope).not.toHaveBeenCalled();
      const wave = getWaveEngineState().waves[0];
      expect(wave.phase).toBe("needsOperator");
      expect(noticeTexts().join("\n")).toContain(
        i18n.t("chat:conductor.wave.verdict.reason.waveInterrupted"),
      );
      expect(noticeActions()).toContainEqual({
        type: "retryWaveDigest",
        sessionId: CONDUCTOR_ID,
        waveId: wave.waveId,
      });
    });

    it("sends the unknown digest anyway when the operator asks for it", async () => {
      await settle();
      const graph = useConductorGraphStore.getState();
      for (const node of Object.values(graph.nodesById)) {
        if (node.role !== "worker") continue;
        graph.patchNode(node.sessionId, { status: "stopped" });
      }
      await settle();
      const waveId = getWaveEngineState().waves[0].waveId;

      // The affordance is not a no-op: the operator has read the notice and
      // is saying "ask anyway", and the digest says every step is unknown.
      retryWaveDigest(CONDUCTOR_ID, waveId);
      await settle();

      expect(deliverEnvelope).toHaveBeenCalledTimes(1);
      expect(deliverEnvelope.mock.calls[0][1]).toContain(
        "Treat its result as unknown",
      );
      // …and it does not claim the conductor answered something unreadably:
      // there was never a first digest for it to answer.
      expect(deliverEnvelope.mock.calls[0][1]).not.toContain(
        "could not be read as a verdict",
      );
      expect(getWaveEngineState().waves[0].phase).toBe("awaitingVerdict");
    });

    it("still digests when at least one step reported (the mixed case)", async () => {
      // A partially interrupted wave keeps its evidence: the steps that did
      // report are real work, and the synthesized "unknown" entries tell the
      // conductor exactly which ones are not. Refusing here would throw away
      // the reports that survived.
      useChatStore.setState({
        messagesBySession: { [CONDUCTOR_ID]: [assistant("plan-1", TWO_STEP)] },
      });
      resetWaveRunnerForTests();
      await settle();
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);

      const graph = useConductorGraphStore.getState();
      graph.attachReport(report("run-1", "Found three callers"));
      graph.patchNode("child-1", { status: "completed" });
      await settle();
      // Step 2 started and then died with the process.
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2);
      graph.patchNode("child-2", { status: "stopped" });
      await settle();

      expect(deliverEnvelope).toHaveBeenCalledTimes(1);
      const digest = deliverEnvelope.mock.calls[0][1];
      expect(digest).toContain("Found three callers");
      expect(digest).toContain("Treat its result as unknown");
    });
  });

  it("re-asks a different question when the operator retries a verdict (M3)", async () => {
    await runWaveToDigest();
    appendConductorMessage(
      assistant("verdict-1", "Nice work everyone, I think that's it."),
    );
    await settle();
    const waveId = getWaveEngineState().waves[0].waveId;

    retryWaveDigest(CONDUCTOR_ID, waveId);
    await settle();

    const first = deliverEnvelope.mock.calls[0][1];
    const retry = deliverEnvelope.mock.calls[1][1];
    // The old behaviour: byte-identical apart from the marker's attempt, so
    // every press bought another turn of the same failure.
    expect(retry.replace(waveDigestMarker(waveId, 1), "")).not.toBe(
      first.replace(waveDigestMarker(waveId, 0), ""),
    );
    expect(retry).toContain("could not be read as a verdict");
    expect(retry).toContain("no distill-verdict block at all");
    // Q5 is intact: the retry was the operator's, and it cost no revision.
    expect(getWaveEngineState().waves[0].revisionCount).toBe(0);
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
