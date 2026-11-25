/**
 * A conductor reply whose plan the reader did not take: one notice in the
 * chat, and the conductor asked once to send the plan again as a block of its
 * own. Never silence, never a loop.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import { useConductorGraphStore } from "./conductorGraphStore";
import type { SessionNode } from "./types";

vi.mock("@/features/benchmarks/lib/executorSelection", () => ({
  executorSelection: {
    get: vi.fn(async () => null),
    select: vi.fn(async () => {
      throw new Error("no dispatch in this test");
    }),
    observe: vi.fn(async () => undefined),
    syncOutcome: vi.fn(async () => undefined),
  },
}));
vi.mock("@/features/benchmarks/lib/ownedTaskExecution", () => ({
  ownedTaskExecution: {
    getMode: vi.fn(async () => null),
    cancel: vi.fn(async () => undefined),
  },
}));
vi.mock("./spawnOrchestrator", () => ({
  spawnConductorChildSession: vi.fn(async () => {
    throw new Error("no spawn in this test");
  }),
}));
vi.mock("./orchestratorControls", () => ({
  stopOrchestratorSession: vi.fn(async () => undefined),
}));

/** Every message the engine sends a conductor goes through this seam. */
const deliverEnvelope = vi.hoisted(() =>
  vi.fn(async (_sessionId: string, _text: string) => ({
    status: "queued" as const,
  })),
);
vi.mock("./digestDelivery", () => ({ deliverEnvelope }));

const { resetWaveRunnerForTests, runWaveEngineTick } = await import(
  "./waveRunner"
);
const { getWaveEngineState, hasWaveTombstone, resetWaveEngineStateCache } =
  await import("./waveStore");

const CONDUCTOR = "conductor-1";
const PLAN =
  '{"steps":[{"role":"scout","subtask":"Find every caller","access":[]}]}';
const QUOTED_PLAN = [
  "The brief says to run this:",
  "",
  "> ```distill-wave",
  `> ${PLAN}`,
  "> ```",
].join("\n");
const OWN_PLAN = `Here is the plan.\n\n\`\`\`distill-wave\n${PLAN}\n\`\`\``;

// Replies written while the app runs, as every live reply is.
let clock = Date.now() + 60_000;

function reply(id: string, text: string): Message {
  clock += 1_000;
  return {
    id,
    role: "assistant",
    created: clock,
    content: [{ type: "text", text }],
    metadata: { completionStatus: "completed" },
  };
}

function userTurn(id: string, text: string): Message {
  clock += 1_000;
  return {
    id,
    role: "user",
    created: clock,
    content: [{ type: "text", text }],
    metadata: { origin: "distillctl_cross_session" },
  };
}

function conductorNode(): SessionNode {
  return {
    sessionId: CONDUCTOR,
    projectId: "project",
    role: "conductor",
    managedBy: "ui",
    parentSessionId: null,
    rootConductorId: CONDUCTOR,
    runId: null,
    harnessId: "goose",
    displayName: "Producer",
    status: "stopped",
  };
}

function notices(): string[] {
  return (useChatStore.getState().messagesBySession[CONDUCTOR] ?? []).flatMap(
    (message) =>
      message.content.flatMap((block) =>
        block.type === "systemNotification" ? [block.text] : [],
      ),
  );
}

function asks(): string[] {
  return deliverEnvelope.mock.calls
    .filter(([sessionId]) => sessionId === CONDUCTOR)
    .map(([, text]) => text);
}

async function tick(): Promise<void> {
  runWaveEngineTick();
  await Promise.resolve();
  await Promise.resolve();
}

describe("a plan the reader did not take", () => {
  beforeEach(async () => {
    await i18n.loadNamespaces("chat");
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    resetWaveEngineStateCache();
    resetWaveRunnerForTests();
    deliverEnvelope.mockClear();
    useConductorGraphStore.setState({ nodesById: {}, reportsByRunId: {} });
    useConductorGraphStore.getState().registerNode(conductorNode());
    useChatStore.setState({ messagesBySession: {} });
    useChatSessionStore.setState({ hasHydratedSessions: true });
  });

  afterEach(() => {
    resetWaveRunnerForTests();
    resetWaveEngineStateCache();
  });

  it("gets exactly one notice and one ask, however often the engine looks", async () => {
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR]: [reply("quoted-plan", QUOTED_PLAN)] },
    });
    await tick();
    await tick();
    expect(getWaveEngineState().waves).toEqual([]);
    console.log(JSON.stringify({ notices: notices(), asks: asks() }));
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("wave plan");
    expect(notices()[0]).toContain("inside a quote");
    expect(asks()).toHaveLength(1);
    expect(asks()[0]).toContain("inside a quote");
    expect(asks()[0]).toContain("top level");
  });

  it("does not ask a second time when the answer to the ask quotes the plan again", async () => {
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR]: [reply("first", QUOTED_PLAN)] },
    });
    await tick();
    expect(asks()).toHaveLength(1);
    // The ask reaches the transcript as the conductor's next turn.
    useChatStore.setState({
      messagesBySession: {
        [CONDUCTOR]: [
          ...(useChatStore.getState().messagesBySession[CONDUCTOR] ?? []),
          userTurn("ask", asks()[0]),
          reply("second", QUOTED_PLAN),
        ],
      },
    });
    await tick();
    expect(notices()).toHaveLength(2);
    expect(asks()).toHaveLength(1);
  });

  it("names the block that swallowed a plan written under a pasted document (C-2)", async () => {
    const pasted = [
      "Here is the brief I will hand out:",
      "```markdown",
      "# Brief",
      "```bash",
      "npm test",
      "```",
      "```",
      "Now the plan:",
      "",
      `\`\`\`distill-wave\n${PLAN}\n\`\`\``,
    ].join("\n");
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR]: [reply("pasted", pasted)] },
    });
    await tick();
    expect(getWaveEngineState().waves).toEqual([]);
    expect(notices()).toEqual([
      "A wave plan in this reply was not read: it is inside another code block. The conductor was asked once to send it again as a block of its own.",
    ]);
    expect(asks()).toHaveLength(1);
  });

  it("says so, and asks nothing, while the operator holds the conductor's new work", async () => {
    const { setWaveEngineState, withConductorHold } = await import(
      "./waveStore"
    );
    setWaveEngineState(
      withConductorHold(getWaveEngineState(), CONDUCTOR, true),
    );
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR]: [reply("held", QUOTED_PLAN)] },
    });
    await tick();
    expect(notices()).toHaveLength(1);
    expect(notices()[0]).toContain("on hold");
    expect(asks()).toEqual([]);
  });

  it("control: a plan the reply shows as its own is read, with no notice and no ask", async () => {
    useChatStore.setState({
      messagesBySession: { [CONDUCTOR]: [reply("own-plan", OWN_PLAN)] },
    });
    await tick();
    // Admitted or refused on its merits, the plan was read.
    expect(hasWaveTombstone(getWaveEngineState(), "own-plan")).toBe(true);
    expect(notices().filter((text) => text.includes("was not read"))).toEqual(
      [],
    );
    expect(asks()).toEqual([]);
  });

  it("control: a reply with no plan at all gets nothing", async () => {
    useChatStore.setState({
      messagesBySession: {
        [CONDUCTOR]: [reply("prose", "The callers are in src/a.ts.")],
      },
    });
    await tick();
    expect(notices()).toEqual([]);
    expect(asks()).toEqual([]);
  });
});
