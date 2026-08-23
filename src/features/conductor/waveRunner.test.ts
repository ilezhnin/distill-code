import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";

const spawnConductorChildSession = vi.hoisted(() => vi.fn());

vi.mock("./spawnOrchestrator", () => ({ spawnConductorChildSession }));

const { resetWaveRunnerForTests, runWaveEngineTick } = await import(
  "./waveRunner"
);
const {
  CONDUCTOR_WAVES_STORAGE_KEY,
  getWaveEngineState,
  hasWaveTombstone,
  resetWaveEngineStateCache,
} = await import("./waveStore");

const CONDUCTOR_ID = "conductor-1";

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

function assistant(id: string, text: string): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function fence(body: string): string {
  return `Here is the plan.\n\n\`\`\`distill-wave\n${body}\n\`\`\``;
}

const TWO_STEP_PLAN = fence(
  '{"steps":[{"role":"scout","subtask":"Find every caller","access":[]},{"role":"qa","subtask":"Write the test plan","access":"all"}]}',
);

function setTranscript(messages: readonly Message[]): void {
  useChatStore.setState({
    messagesBySession: { [CONDUCTOR_ID]: [...messages] },
  });
}

function conductorMessages(): Message[] {
  return useChatStore.getState().messagesBySession[CONDUCTOR_ID] ?? [];
}

function noticeTexts(): string[] {
  return conductorMessages().flatMap((message) =>
    message.content.flatMap((block) =>
      block.type === "systemNotification" ? [block.text] : [],
    ),
  );
}

function registerSpawnedChild(args: {
  sessionId: string;
  waveId: string;
  stepIndex: number;
  runId: string;
  status?: SessionNode["status"];
}): void {
  useConductorGraphStore.getState().registerNode({
    sessionId: args.sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "wave",
    parentSessionId: CONDUCTOR_ID,
    rootConductorId: CONDUCTOR_ID,
    runId: args.runId,
    harnessId: "goose",
    displayName: args.sessionId,
    status: args.status ?? "running",
    waveId: args.waveId,
    stepIndex: args.stepIndex,
  });
}

describe("waveRunner", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    window.localStorage.clear();
    resetWaveEngineStateCache();
    resetWaveRunnerForTests();
    spawnConductorChildSession.mockReset();
    let counter = 0;
    spawnConductorChildSession.mockImplementation(async (args) => {
      counter += 1;
      const sessionId = `child-${args.stepIndex}`;
      const runId = `run-${counter}`;
      registerSpawnedChild({
        sessionId,
        waveId: args.waveId,
        stepIndex: args.stepIndex,
        runId,
      });
      return { sessionId, runId };
    });
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ hasHydratedSessions: true });
  });

  afterEach(() => {
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
  });

  it("does nothing before the session store has hydrated", () => {
    useChatSessionStore.setState({ hasHydratedSessions: false });
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    expect(spawnConductorChildSession).not.toHaveBeenCalled();
  });

  it("spawns the access:[] step immediately and holds the access:all step", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);

    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    const [args] = spawnConductorChildSession.mock.calls[0];
    expect(args).toMatchObject({
      parentSessionId: CONDUCTOR_ID,
      role: "worker",
      managedBy: "wave",
      stepIndex: 0,
      anchorMessageId: "plan-1",
      roleId: "scout",
      task: "Find every caller",
    });
    expect(args.waveId).toBeTruthy();
    expect(args.prompt).toContain("Find every caller");

    const state = getWaveEngineState();
    expect(state.waves).toHaveLength(1);
    expect(hasWaveTombstone(state, "plan-1")).toBe(true);
  });

  it("starts the access:all step with the earlier report once step 0 is terminal", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    const graph = useConductorGraphStore.getState();
    graph.patchNode("child-0", { status: "completed" });
    graph.attachReport({
      runId: "run-1",
      status: "completed",
      summary: "Three callers in src/",
      decisions: [],
      artifacts: [],
      risks: [],
      needsOperator: false,
      nextSuggestedTask: null,
    });

    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
    const [second] = spawnConductorChildSession.mock.calls[1];
    expect(second).toMatchObject({ stepIndex: 1, roleId: "qa" });
    expect(second.prompt).toContain("Three callers in src/");
  });

  it("shows the enumerated reason and spawns nothing for a broken fence", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", fence("{not json}"))]);

    runWaveEngineTick();

    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(noticeTexts()).toHaveLength(1);
    expect(noticeTexts()[0]).toContain(
      i18n.t("chat:conductor.wave.reason.malformedJson"),
    );
    const notice = conductorMessages().at(-1);
    expect(notice?.content[0]).toMatchObject({
      type: "systemNotification",
      notificationType: "error",
      action: { type: "retryWavePlan", sessionId: CONDUCTOR_ID },
    });
    expect(getWaveEngineState().waves).toHaveLength(0);
    expect(hasWaveTombstone(getWaveEngineState(), "plan-1")).toBe(true);
  });

  it("refuses the whole plan when a step names a model, before any spawn", () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence(
          '{"steps":[{"role":"scout","subtask":"Look","access":[]},{"role":"qa","subtask":"Check","access":[],"model":"gpt-5"}]}',
        ),
      ),
    ]);

    runWaveEngineTick();

    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(noticeTexts()[0]).toContain(
      i18n.t("chat:conductor.wave.reason.stepModelUnsupported", { step: 2 }),
    );
  });

  it("never re-processes a plan message, however often the tick fires", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence('{"steps":[{"role":"scout","subtask":"Look","access":[]}]}'),
      ),
    ]);

    for (let index = 0; index < 5; index += 1) runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    for (let index = 0; index < 5; index += 1) runWaveEngineTick();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
  });

  it("re-errors nothing when a broken fence is ticked repeatedly", () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", fence("{not json}"))]);
    for (let index = 0; index < 4; index += 1) runWaveEngineTick();
    expect(noticeTexts()).toHaveLength(1);
  });

  it("resumes a wave after a restart without spawning a second worker", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );

    // Restart: the process-local guards are gone, the persisted state is not.
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
    expect(window.localStorage.getItem(CONDUCTOR_WAVES_STORAGE_KEY)).toContain(
      "plan-1",
    );

    runWaveEngineTick();
    await Promise.resolve();
    expect(spawnConductorChildSession).toHaveBeenCalledTimes(1);
    expect(getWaveEngineState().waves[0].steps[0]).toMatchObject({
      phase: "spawned",
      sessionId: "child-0",
    });
  });

  it("respawns a step whose spawn died before its child existed", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([
      assistant(
        "plan-1",
        fence('{"steps":[{"role":"scout","subtask":"Look","access":[]}]}'),
      ),
    ]);
    spawnConductorChildSession.mockImplementation(
      () => new Promise(() => undefined),
    );
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(1),
    );
    expect(getWaveEngineState().waves[0].steps[0].phase).toBe("spawning");

    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
    spawnConductorChildSession.mockResolvedValue({
      sessionId: "child-0",
      runId: "run-9",
    });
    runWaveEngineTick();
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
  });

  it("marks a step failed and warns when its spawn throws", async () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    setTranscript([assistant("plan-1", TWO_STEP_PLAN)]);
    spawnConductorChildSession.mockRejectedValue(
      new Error("Conductor has no working folder yet."),
    );

    runWaveEngineTick();
    await vi.waitFor(() => expect(noticeTexts().length).toBeGreaterThan(0));
    expect(noticeTexts().join("\n")).toContain("no working folder");
    // The failed step does not block the access:"all" step behind it.
    await vi.waitFor(() =>
      expect(spawnConductorChildSession).toHaveBeenCalledTimes(2),
    );
  });

  it('leaves old managedBy:"ui" children alone', () => {
    useConductorGraphStore.getState().registerNode(conductorNode());
    useConductorGraphStore.getState().registerNode({
      sessionId: "legacy-1",
      projectId: "project",
      role: "worker",
      managedBy: "ui",
      parentSessionId: CONDUCTOR_ID,
      rootConductorId: CONDUCTOR_ID,
      runId: "run-legacy",
      harnessId: "goose",
      displayName: "Legacy",
      status: "completed",
    });
    setTranscript([assistant("chat-1", "Just an answer, no fence.")]);

    runWaveEngineTick();

    expect(spawnConductorChildSession).not.toHaveBeenCalled();
    expect(getWaveEngineState().waves).toHaveLength(0);
    expect(noticeTexts()).toEqual([]);
  });
});
