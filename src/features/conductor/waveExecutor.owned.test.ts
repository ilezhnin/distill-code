import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OwnedTaskModeV2,
  OwnedTaskRequestV2,
} from "@/features/benchmarks/lib/ownedTaskExecution";

import type { WaveStep } from "./distillWave";
import { createWaveState } from "./waveEngine";
import {
  ownedWaveLineage,
  ownedWaveRootContextId,
  prepareWaveExecutor,
} from "./waveExecutor";

const io = vi.hoisted(() => ({
  prepare: vi.fn(),
  get: vi.fn(),
  getMode: vi.fn(),
  nativeChoices: vi.fn(),
  bindings: new Map<string, string>(),
}));

vi.mock("@/features/benchmarks/lib/ownedTaskExecution", async (original) => ({
  ...(await original<
    typeof import("@/features/benchmarks/lib/ownedTaskExecution")
  >()),
  ownedTaskExecution: {
    prepare: io.prepare,
    get: io.get,
    getMode: io.getMode,
    nativeChoices: io.nativeChoices,
  },
}));
vi.mock("@/features/chat/lib/executionOwnership", async (original) => ({
  ...(await original<
    typeof import("@/features/chat/lib/executionOwnership")
  >()),
  taskBindingId: (sessionId: string) => io.bindings.get(sessionId) ?? null,
}));

function role(roleId: string, workClassId: string) {
  return {
    sourceId: `source-${roleId}`,
    sourcePath: `C:/invented/agents/${roleId}.md`,
    sourceHash: `hash-${roleId}`,
    roleId,
    rolePrompt: `Invented ${roleId} instructions.`,
    workClassId,
    prior: [],
    priorReason: "explicit_native_default_order",
    unknownReasons: [],
    defaultEffort: null,
    defaultFastMode: null,
  };
}

const mode: OwnedTaskModeV2 = {
  schemaVersion: 2,
  request: {
    schemaVersion: 2,
    contextId: "invented-conductor",
    surface: "wave",
    executionProfile: "protected_repository",
    repository: {
      path: "C:/invented/repo",
      commit: "a".repeat(40),
      tree: "b".repeat(40),
    },
    limits: { timeoutSeconds: 600, maxTurns: 1, maxArtifactBytes: 65536 },
    roles: [],
    providerIds: ["claude-acp"],
    acknowledgedContractHash: "consent",
  },
  consent: {
    surface: "wave",
    executionProfile: "protected_repository",
    repository: null,
    repositoryArchiveHash: null,
    limits: { timeoutSeconds: 600, maxTurns: 1, maxArtifactBytes: 65536 },
    permissions: {} as OwnedTaskModeV2["consent"]["permissions"],
    roles: [
      role("implementer", "code-implement"),
      role("reviewer", "code-review"),
      role("qa", "testing"),
    ],
    providerIds: ["claude-acp"],
    complete: true,
    unknownReasons: [],
    artifactHash: "consent",
  },
  createdAt: 1,
  artifactHash: "native-mode",
};

const plan: WaveStep[] = [
  { role: "implementer", subtask: "Implement the invented fix", access: [] },
  { role: "reviewer", subtask: "Review the invented fix", access: "all" },
  { role: "qa", subtask: "Verify the invented fix", access: "all" },
];

function wave(over: Partial<Parameters<typeof createWaveState>[0]> = {}) {
  return createWaveState({
    waveId: "wave-1",
    conductorSessionId: "invented-conductor",
    planMessageId: "plan-1",
    steps: plan,
    createdAt: 1,
    ...over,
  });
}

function spawn(stepIndex: number, step: WaveStep = plan[stepIndex]) {
  return { stepIndex, step, previousReports: [], totalSteps: plan.length };
}

function requested(): OwnedTaskRequestV2 {
  return io.prepare.mock.calls.at(-1)?.[0];
}

beforeEach(() => {
  io.prepare
    .mockReset()
    .mockImplementation(async (request: OwnedTaskRequestV2) => ({
      binding: {
        id: `binding-for-${request.requestKey}`,
        request: { ...request, waveMode: null },
        decision: { source: "prior" },
      },
      session: { owned: { sessionId: `session-for-${request.requestKey}` } },
    }));
  io.get.mockReset().mockImplementation(async (id: string) => ({
    binding: { id, request: { contextId: `context-of-${id}` } },
  }));
  io.getMode.mockReset().mockResolvedValue(mode);
  io.bindings.clear();
});

describe("owned v2 wave executor", () => {
  it("opens one root per request and binds each step's acknowledged role, class and allowance", async () => {
    const first = wave();
    await prepareWaveExecutor(first, spawn(0), "", {});
    expect(requested()).toMatchObject({
      schemaVersion: 2,
      requestKey: "wave:wave-1:step:0",
      surface: "wave",
      contextId: ownedWaveRootContextId(first),
      mode: { contextId: "invented-conductor", artifactHash: "native-mode" },
      roleSourceId: "source-implementer",
      workClassId: "code-implement",
      prompt: "Implement the invented fix",
      hardCandidateKey: null,
      stepBudgetSeconds: 600,
      entry: null,
    });
    expect(ownedWaveRootContextId(first)).toBe(
      "invented-conductor:wave:root:plan-1",
    );
  });

  it("plans the whole step sequence at a fresh root only, so the host can find its trajectory certificate", async () => {
    await prepareWaveExecutor(wave(), spawn(0), "", {});
    expect(requested().plannedTrajectory).toEqual([
      {
        roleSourceId: "source-implementer",
        workClassId: "code-implement",
        stepBudgetSeconds: 600,
      },
      {
        roleSourceId: "source-reviewer",
        workClassId: "code-review",
        stepBudgetSeconds: 600,
      },
      {
        roleSourceId: "source-qa",
        workClassId: "testing",
        stepBudgetSeconds: 600,
      },
    ]);
    // A step whose own shape cannot resolve fails at its own spawn; the
    // root then plans nothing instead of refusing its own valid step.
    const unresolved = wave({
      steps: [plan[0], { ...plan[1], role: "architect" }],
    });
    await prepareWaveExecutor(unresolved, spawn(0), "", {});
    expect(requested().plannedTrajectory).toBeNull();
    io.bindings.set("child-0", "binding-0");
    const later = wave();
    later.steps[0] = { ...later.steps[0], sessionId: "child-0" };
    await prepareWaveExecutor(later, spawn(1), "", {});
    expect(requested().plannedTrajectory).toBeNull();
  });

  it("chains later steps to the committed root and adopts the root's native context", async () => {
    io.bindings.set("child-0", "binding-0");
    const first = wave();
    first.steps[0] = { ...first.steps[0], sessionId: "child-0" };
    await prepareWaveExecutor(first, spawn(1), "", {});
    expect(io.get).toHaveBeenCalledWith("binding-0");
    expect(requested()).toMatchObject({
      contextId: "context-of-binding-0",
      roleSourceId: "source-reviewer",
      workClassId: "code-review",
      entry: {
        rootBindingId: "binding-0",
        previousBindingIds: ["binding-0"],
        includePreviousOutput: true,
      },
    });
  });

  it("continues a revision from the earlier wave's committed lineage and root", async () => {
    const revision = wave({
      waveId: "wave-2",
      planMessageId: "verdict-1",
      rootRequestId: "plan-1",
      revisionCount: 1,
      carriedBindingIds: ["binding-0", "binding-1", "binding-2"],
    });
    io.bindings.set("revision-child-0", "binding-3");
    revision.steps[0] = { ...revision.steps[0], sessionId: "revision-child-0" };
    await prepareWaveExecutor(revision, spawn(1), "", {});
    expect(requested()).toMatchObject({
      requestKey: "wave:wave-2:step:1",
      contextId: "context-of-binding-0",
      entry: {
        rootBindingId: "binding-0",
        previousBindingIds: [
          "binding-0",
          "binding-1",
          "binding-2",
          "binding-3",
        ],
        includePreviousOutput: true,
      },
    });
  });

  it("refuses a revision with no completed native step to continue, and never opens a fresh root", async () => {
    const revision = wave({
      waveId: "wave-2",
      rootRequestId: "plan-1",
      revisionCount: 1,
    });
    await expect(
      prepareWaveExecutor(revision, spawn(0), "", {}),
    ).rejects.toThrow(/no completed native step of the earlier wave/);
    expect(io.prepare).not.toHaveBeenCalled();
  });

  it("refuses unbound predecessors, unacknowledged roles and caps the consent does not attest", async () => {
    const first = wave();
    first.steps[0] = { ...first.steps[0], sessionId: "unbound-child" };
    await expect(prepareWaveExecutor(first, spawn(1), "", {})).rejects.toThrow(
      /committed predecessor bindings/,
    );
    await expect(
      prepareWaveExecutor(
        wave(),
        spawn(0, { ...plan[0], role: "architect" }),
        "",
        {},
      ),
    ).rejects.toThrow(/one acknowledged native role source/);
    await expect(
      prepareWaveExecutor(
        wave(),
        spawn(0, { ...plan[0], budget: { usd: 1 } }),
        "",
        {},
      ),
    ).rejects.toThrow(/monetary or token/);
    await expect(
      prepareWaveExecutor(
        wave(),
        spawn(0, { ...plan[0], budget: { minutes: 11 } }),
        "",
        {},
      ),
    ).rejects.toThrow(/exceeds the acknowledged native root cap/);
    expect(io.prepare).not.toHaveBeenCalled();
  });

  it("carries only completed owned steps, after the earlier lineage", () => {
    io.bindings.set("child-0", "binding-0");
    io.bindings.set("child-1", "binding-1");
    io.bindings.set("child-2", "binding-2");
    const finished = wave({ carriedBindingIds: ["binding-earlier"] });
    finished.steps = finished.steps.map((step) => ({
      ...step,
      sessionId: `child-${step.stepIndex}`,
    }));
    const statuses = ["completed", "completed", "failed"];
    expect(
      ownedWaveLineage(finished, (stepIndex) => statuses[stepIndex]),
    ).toEqual(["binding-earlier", "binding-0", "binding-1"]);
  });
});
