/**
 * E3b — checking that the files a wave claims to have produced are there.
 *
 * The verdict already refuses to honour an `accept` on a checkable wave whose
 * verification step produced no artifacts (E2, `waveVerdict.ts`). But the
 * artifacts array is written by the same model whose work is being judged: a
 * verifier that never opened a file and listed three plausible paths passes
 * that gate exactly as well as one that did the work. E2 checks that a claim
 * was made. This checks whether the claim is true.
 *
 * Like {@link ./waveGitProbe}, the answer comes from the app, not from a
 * model: `path_exists` on every path any report of the wave named. A path that
 * is not there becomes a stated fact in the digest, and turns the conductor's
 * `accept` into `needsOperator` — the conductor may still be right about the
 * work, but nobody should close the loop on a report that named a file which
 * does not exist.
 *
 * Fail-soft in one direction only. A probe that cannot run at all (no Tauri, a
 * backend that throws) settles with nothing checked and changes no verdict —
 * an infrastructure failure must never be read as a worker lying. A path the
 * backend answers "no" about is a fact and is used as one.
 */

import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { pathExists } from "@/shared/api/system";

import type { StructuredReport } from "./types";
import type { WaveState } from "./waveEngine";
import { updateWaveEngineState, withWave } from "./waveStore";

/**
 * Outer bound on the whole check. The wave's digest waits on this, so it is
 * bounded the same way the git probe is: a dead IPC bridge must not park a
 * wave on `digestPending` forever.
 */
export const WAVE_ARTIFACT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Ceiling on how many paths one wave's check will look at.
 *
 * Five steps of a report format with no length limit can name a great many
 * paths, and each one is an IPC round trip inside a bounded window. Past this
 * the check states how many it looked at, which is honest, rather than
 * timing out and stating nothing, which is not.
 */
export const MAX_CHECKED_ARTIFACT_PATHS = 40;

export interface WaveArtifactFacts {
  /** How many distinct paths the app actually asked about. */
  checked: number;
  /** Those the backend said are not there, in report order. */
  missing: readonly string[];
}

interface WaveArtifactProbeIo {
  /** False when there is no Tauri to ask — the probe then settles inline. */
  canProbe: () => boolean;
  exists: (path: string) => Promise<boolean>;
  workingDirOf: (sessionId: string) => string | undefined;
}

const defaultIo: WaveArtifactProbeIo = {
  canProbe: () =>
    typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__),
  exists: pathExists,
  workingDirOf: (sessionId) =>
    useChatSessionStore.getState().getSession(sessionId)?.workingDir?.trim() ||
    undefined,
};

let io: WaveArtifactProbeIo = defaultIo;

/** Waves with a check in flight. */
const inFlightProbes = new Set<string>();

/**
 * Every distinct path the wave's reports named, in the order they were named.
 *
 * Only `path` is read. A `url` artifact is a link to something that does not
 * live on this disk, and reporting it as "missing" would be a false accusation
 * from a check that never looked.
 */
export function artifactPathsOf(
  reports: readonly StructuredReport[],
): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const report of reports) {
    for (const artifact of report.artifacts) {
      const path = artifact.path?.trim();
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

/**
 * Resolve a reported path the way a worker meant it.
 *
 * Workers write repository-relative paths because that is what they see. An
 * absolute path, a `~` path, or a URI is left alone: the first two are already
 * answerable, and the third is not this check's business.
 */
export function resolveArtifactPath(
  reported: string,
  workingDir: string | undefined,
): string {
  const path = reported.trim();
  if (!workingDir) return path;
  if (
    path.startsWith("/") ||
    path.startsWith("~") ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
  ) {
    return path;
  }
  const separator = workingDir.includes("\\") ? "\\" : "/";
  return `${workingDir.replace(/[\\/]+$/, "")}${separator}${path.replace(/^\.[\\/]/, "")}`;
}

function settle(waveId: string, facts: WaveArtifactFacts): void {
  updateWaveEngineState((engineState) => {
    const wave = engineState.waves.find(
      (candidate) => candidate.waveId === waveId,
    );
    if (!wave) return engineState;
    return withWave(engineState, {
      ...wave,
      artifactsProbed: true,
      checkedArtifacts: facts.checked,
      ...(facts.missing.length > 0 ? { missingArtifacts: facts.missing } : {}),
    });
  });
}

/**
 * Starts the artifact check for one wave, if one can run.
 *
 * Returns `true` while the check is in flight — the digest pass waits on that,
 * so the fact lands before the conductor is asked. Returns `false` when no
 * check will ever land (no Tauri, no reports naming a path), and the caller
 * settles the flag inline rather than waiting for an answer that cannot come.
 */
export function startWaveArtifactProbe(args: {
  waveId: string;
  conductorSessionId: string;
  reports: readonly StructuredReport[];
  /** Re-runs the engine tick once the check has settled. */
  onSettled?: () => void;
}): boolean {
  if (inFlightProbes.has(args.waveId)) return true;
  if (!io.canProbe()) return false;
  const paths = artifactPathsOf(args.reports);
  if (paths.length === 0) return false;

  inFlightProbes.add(args.waveId);
  void (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const workingDir = io.workingDirOf(args.conductorSessionId);
      const looked = paths.slice(0, MAX_CHECKED_ARTIFACT_PATHS);
      const check = (async () => {
        const missing: string[] = [];
        for (const reported of looked) {
          // One rejection is an infrastructure answer, not a verdict about
          // the file: it is skipped rather than counted as missing.
          const found = await io
            .exists(resolveArtifactPath(reported, workingDir))
            .catch(() => true);
          if (!found) missing.push(reported);
        }
        return { checked: looked.length, missing };
      })();
      check.catch(() => {});
      const facts = await Promise.race([
        check,
        new Promise<WaveArtifactFacts>((resolve) => {
          timer = setTimeout(
            () => resolve({ checked: 0, missing: [] }),
            WAVE_ARTIFACT_PROBE_TIMEOUT_MS,
          );
        }),
      ]).catch(() => ({ checked: 0, missing: [] }));
      settle(args.waveId, facts);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      inFlightProbes.delete(args.waveId);
      args.onSettled?.();
    }
  })();
  return true;
}

/**
 * The E3b facts a wave holds, or `undefined` when nothing was checked.
 *
 * "Nothing was checked" and "everything checked out" are different answers and
 * must stay so: only the second may be stated to the conductor as evidence.
 */
export function waveArtifactFactsOf(
  wave: Pick<WaveState, "checkedArtifacts" | "missingArtifacts">,
): WaveArtifactFacts | undefined {
  if (!wave.checkedArtifacts) return undefined;
  return {
    checked: wave.checkedArtifacts,
    missing: wave.missingArtifacts ?? [],
  };
}

/** Swaps the probe's IO. Tests only; call with no argument to restore. */
export function setWaveArtifactProbeIoForTests(
  next?: Partial<WaveArtifactProbeIo>,
): void {
  io = next ? { ...defaultIo, ...next } : defaultIo;
}

/** Clears the process-local guards. Tests only. */
export function resetWaveArtifactProbeForTests(): void {
  inFlightProbes.clear();
  io = defaultIo;
}
