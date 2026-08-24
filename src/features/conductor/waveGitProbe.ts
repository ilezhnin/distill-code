/**
 * E3a — the one fact in the wave loop that no model authored.
 *
 * Everything else the conductor judges is a worker's account of itself: the
 * reports are model-written, the digest quotes them, and the verdict grades
 * them — unassisted self-critique, the regime where verifier true-negative
 * rates are known to be dismal. This module puts a single app-authored fact
 * into that loop: `git status` of the conductor's working folder, counted at
 * admission and again when the wave finishes. A wave that claims work and
 * changed nothing, or changed things nobody reported, becomes visible as a
 * mismatch between two numbers the app measured itself.
 *
 * The probes are deliberately allowed to fail: git can be slow, the folder can
 * be missing, the app can be running without Tauri at all (vitest). A failed
 * probe degrades the digest line or omits it — it must never block the loop,
 * so the digest-time probe settles `gitDigestProbed` on every outcome and is
 * raced against its own timeout on top of the backend's.
 */

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { getGitState } from "@/shared/api/git";
import type { GitState } from "@/shared/types/git";

import { updateWaveEngineState, withWave } from "./waveStore";

/**
 * Outer bound on one probe. The backend command has its own timeout; this one
 * exists so a dead IPC bridge cannot park a wave on `digestPending` forever.
 */
export const WAVE_GIT_PROBE_TIMEOUT_MS = 10_000;

export type WaveGitProbePoint = "admission" | "digest";

interface WaveGitProbeIo {
  /** False when there is no Tauri to ask — the probe then settles inline. */
  canProbe: () => boolean;
  readGitState: (path: string) => Promise<GitState>;
}

const defaultIo: WaveGitProbeIo = {
  canProbe: () =>
    typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__),
  readGitState: getGitState,
};

let io: WaveGitProbeIo = defaultIo;

/** `waveId:point` of probes currently awaiting git. */
const inFlightProbes = new Set<string>();

function probeKey(waveId: string, point: WaveGitProbePoint): string {
  return `${waveId}:${point}`;
}

/**
 * Writes one settled probe into the wave, whatever the outcome was.
 *
 * A folder that is not a git repository yields no count — a permanent 0/0
 * "delta" would read as "the workers changed nothing" about a folder git
 * never watched. The digest-time flag is set even then: settled-without-a-
 * number is an answer, waiting longer is not.
 */
function settleProbe(
  waveId: string,
  point: WaveGitProbePoint,
  state: GitState | null,
): void {
  updateWaveEngineState((engineState) => {
    const wave = engineState.waves.find(
      (candidate) => candidate.waveId === waveId,
    );
    if (!wave) return engineState;
    const dirty =
      state?.isGitRepo === true &&
      Number.isInteger(state.dirtyFileCount) &&
      state.dirtyFileCount >= 0
        ? state.dirtyFileCount
        : undefined;
    if (point === "admission") {
      if (dirty === undefined || wave.gitDirtyAtAdmission !== undefined) {
        return engineState;
      }
      return withWave(engineState, { ...wave, gitDirtyAtAdmission: dirty });
    }
    return withWave(engineState, {
      ...wave,
      gitDigestProbed: true,
      ...(dirty !== undefined ? { gitDirtyAtDigest: dirty } : {}),
    });
  });
}

/**
 * Starts one git probe for one wave, if one can run.
 *
 * Returns `true` while an async probe is in flight for this key — the caller
 * may wait on it (the digest pass does, so the measurement makes it into the
 * digest). Returns `false` when no probe will ever land: no Tauri, or the
 * conductor has no working folder. The digest pass then settles the flag
 * inline instead of waiting for an answer that cannot come.
 */
export function startWaveGitProbe(args: {
  waveId: string;
  conductorSessionId: string;
  point: WaveGitProbePoint;
  /** Re-runs the engine tick once the probe has settled. */
  onSettled?: () => void;
}): boolean {
  const key = probeKey(args.waveId, args.point);
  if (inFlightProbes.has(key)) return true;
  if (!io.canProbe()) return false;
  const workingDir = useChatSessionStore
    .getState()
    .getSession(args.conductorSessionId)
    ?.workingDir?.trim();
  if (!workingDir) return false;

  inFlightProbes.add(key);
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = io.readGitState(workingDir);
      // The loser of the race may still reject later; that rejection is
      // nobody's business once the probe has settled.
      read.catch(() => {});
      const state = await Promise.race([
        read,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), WAVE_GIT_PROBE_TIMEOUT_MS);
        }),
      ]).catch(() => null);
      settleProbe(args.waveId, args.point, state);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlightProbes.delete(key);
      args.onSettled?.();
    }
  })();
  return true;
}

/** Swaps the probe's IO. Tests only; call with no argument to restore. */
export function setWaveGitProbeIoForTests(
  next?: Partial<WaveGitProbeIo>,
): void {
  io = next ? { ...defaultIo, ...next } : defaultIo;
}

/** Clears the process-local guards. Tests only. */
export function resetWaveGitProbeForTests(): void {
  inFlightProbes.clear();
  io = defaultIo;
}
