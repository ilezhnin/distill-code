import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ChatSession,
  useChatSessionStore,
} from "@/features/chat/stores/chatSessionStore";
import type { GitState } from "@/shared/types/git";

import { createWaveState } from "./waveEngine";
import {
  WAVE_GIT_PROBE_TIMEOUT_MS,
  resetWaveGitProbeForTests,
  setWaveGitProbeIoForTests,
  startWaveGitProbe,
} from "./waveGitProbe";
import {
  getWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} from "./waveStore";

const CONDUCTOR_ID = "conductor-1";
const WAVE_ID = "wave-1";

function conductorSession(workingDir: string | undefined): ChatSession {
  return {
    id: CONDUCTOR_ID,
    title: "Conductor",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    messageCount: 0,
    ...(workingDir !== undefined ? { workingDir } : {}),
  };
}

function gitState(dirtyFileCount: number, isGitRepo = true): GitState {
  return {
    isGitRepo,
    currentBranch: isGitRepo ? "main" : null,
    dirtyFileCount,
    incomingCommitCount: 0,
    worktrees: [],
    isWorktree: false,
    mainWorktreePath: null,
    localBranches: [],
  };
}

function seedWave(): void {
  setWaveEngineState(
    withWave(
      getWaveEngineState(),
      createWaveState({
        waveId: WAVE_ID,
        conductorSessionId: CONDUCTOR_ID,
        planMessageId: "plan-1",
        steps: [{ role: "scout", subtask: "look", access: [] }],
        createdAt: 1,
      }),
    ),
  );
}

function liveWave() {
  const wave = getWaveEngineState().waves.find(
    (candidate) => candidate.waveId === WAVE_ID,
  );
  if (!wave) throw new Error("the seeded wave is gone");
  return wave;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("startWaveGitProbe", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetWaveEngineStateCache();
    resetWaveGitProbeForTests();
    useChatSessionStore.setState({
      hasHydratedSessions: true,
      sessions: [conductorSession("/repo")],
    });
    seedWave();
  });

  afterEach(() => {
    resetWaveGitProbeForTests();
    vi.useRealTimers();
  });

  it("records the admission baseline on the wave", async () => {
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: async (path) => {
        expect(path).toBe("/repo");
        return gitState(3);
      },
    });

    expect(
      startWaveGitProbe({
        waveId: WAVE_ID,
        conductorSessionId: CONDUCTOR_ID,
        point: "admission",
      }),
    ).toBe(true);
    await flush();
    expect(liveWave().gitDirtyAtAdmission).toBe(3);
    expect(liveWave().gitDigestProbed).toBeUndefined();
  });

  it("records the digest count, settles the flag, and re-ticks the caller", async () => {
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: async () => gitState(7),
    });
    const onSettled = vi.fn();

    expect(
      startWaveGitProbe({
        waveId: WAVE_ID,
        conductorSessionId: CONDUCTOR_ID,
        point: "digest",
        onSettled,
      }),
    ).toBe(true);
    await flush();
    expect(liveWave().gitDirtyAtDigest).toBe(7);
    expect(liveWave().gitDigestProbed).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it("settles the digest flag with no number when git fails — evidence may be missing, the loop may not block", async () => {
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: async () => {
        throw new Error("git timed out");
      },
    });

    startWaveGitProbe({
      waveId: WAVE_ID,
      conductorSessionId: CONDUCTOR_ID,
      point: "digest",
    });
    await flush();
    expect(liveWave().gitDigestProbed).toBe(true);
    expect(liveWave().gitDirtyAtDigest).toBeUndefined();
  });

  it("records no count for a folder git does not watch", async () => {
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: async () => gitState(0, false),
    });

    startWaveGitProbe({
      waveId: WAVE_ID,
      conductorSessionId: CONDUCTOR_ID,
      point: "digest",
    });
    await flush();
    // A permanent 0/0 "delta" would read as "the workers changed nothing"
    // about a folder git never saw; settled-without-a-number is the honest
    // answer.
    expect(liveWave().gitDigestProbed).toBe(true);
    expect(liveWave().gitDirtyAtDigest).toBeUndefined();
  });

  it("declines synchronously when there is no Tauri to ask", () => {
    setWaveGitProbeIoForTests({ canProbe: () => false });
    expect(
      startWaveGitProbe({
        waveId: WAVE_ID,
        conductorSessionId: CONDUCTOR_ID,
        point: "digest",
      }),
    ).toBe(false);
  });

  it("declines synchronously when the conductor has no working folder", () => {
    useChatSessionStore.setState({
      hasHydratedSessions: true,
      sessions: [conductorSession(undefined)],
    });
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: async () => gitState(1),
    });
    expect(
      startWaveGitProbe({
        waveId: WAVE_ID,
        conductorSessionId: CONDUCTOR_ID,
        point: "digest",
      }),
    ).toBe(false);
  });

  it("runs one probe per wave and point, however often it is asked", async () => {
    const readGitState = vi.fn(async () => gitState(2));
    setWaveGitProbeIoForTests({ canProbe: () => true, readGitState });

    startWaveGitProbe({
      waveId: WAVE_ID,
      conductorSessionId: CONDUCTOR_ID,
      point: "digest",
    });
    expect(
      startWaveGitProbe({
        waveId: WAVE_ID,
        conductorSessionId: CONDUCTOR_ID,
        point: "digest",
      }),
    ).toBe(true);
    await flush();
    expect(readGitState).toHaveBeenCalledTimes(1);
  });

  it("gives up on a probe that outlives its timeout", async () => {
    vi.useFakeTimers();
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      // A dead IPC bridge: the promise never settles on its own.
      readGitState: () => new Promise<GitState>(() => {}),
    });

    startWaveGitProbe({
      waveId: WAVE_ID,
      conductorSessionId: CONDUCTOR_ID,
      point: "digest",
    });
    await vi.advanceTimersByTimeAsync(WAVE_GIT_PROBE_TIMEOUT_MS + 1);
    expect(liveWave().gitDigestProbed).toBe(true);
    expect(liveWave().gitDirtyAtDigest).toBeUndefined();
  });

  it("does nothing when the wave is gone by the time git answers", async () => {
    setWaveGitProbeIoForTests({
      canProbe: () => true,
      readGitState: async () => gitState(4),
    });
    startWaveGitProbe({
      waveId: "wave-that-closed",
      conductorSessionId: CONDUCTOR_ID,
      point: "digest",
    });
    await flush();
    // The seeded wave is untouched; the settle for the missing wave no-ops.
    expect(liveWave().gitDigestProbed).toBeUndefined();
  });
});
