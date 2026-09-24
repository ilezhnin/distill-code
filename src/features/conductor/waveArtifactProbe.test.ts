import { afterEach, describe, expect, it } from "vitest";

import type { StructuredReport } from "./types";
import {
  MAX_CHECKED_ARTIFACT_PATHS,
  resetWaveArtifactProbeForTests,
  resolveArtifactPath,
  startWaveArtifactProbe,
  setWaveArtifactProbeIoForTests,
} from "./waveArtifactProbe";
import { createWaveState } from "./waveEngine";
import {
  getWaveEngineState,
  resetWaveEngineStateCache,
  setWaveEngineState,
  withWave,
} from "./waveStore";

function report(over: Partial<StructuredReport> = {}): StructuredReport {
  return {
    runId: "run-1",
    status: "completed",
    summary: "Wrote the module",
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...over,
  };
}

afterEach(() => {
  resetWaveArtifactProbeForTests();
  resetWaveEngineStateCache();
});

describe("resolveArtifactPath", () => {
  it("leaves UNC and root-relative Windows paths alone", () => {
    expect(resolveArtifactPath("\\\\host\\share\\a.ts", "C:\\repo")).toBe(
      "\\\\host\\share\\a.ts",
    );
    expect(resolveArtifactPath("\\src\\a.ts", "C:\\repo")).toBe("\\src\\a.ts");
  });
});

describe("startWaveArtifactProbe", () => {
  function seedWave() {
    const wave = createWaveState({
      waveId: "w1",
      conductorSessionId: "c1",
      planMessageId: "plan-1",
      steps: [{ role: "writer", subtask: "Write it", access: [] }],
      createdAt: 1,
    });
    setWaveEngineState(withWave(getWaveEngineState(), wave));
    return wave;
  }

  function waveNow() {
    const wave = getWaveEngineState().waves.find((w) => w.waveId === "w1");
    if (!wave) throw new Error("wave vanished");
    return wave;
  }

  async function settled(started: boolean) {
    expect(started).toBe(true);
    // The probe resolves on the microtask queue behind its awaits.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it("records the paths the filesystem says are not there", async () => {
    seedWave();
    setWaveArtifactProbeIoForTests({
      canProbe: () => true,
      workingDirOf: () => "/repo",
      exists: async (path) => path !== "/repo/src/ghost.ts",
    });
    await settled(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [
          report({
            artifacts: [
              { label: "real", path: "src/real.ts" },
              { label: "ghost", path: "src/ghost.ts" },
            ],
          }),
        ],
      }),
    );
    expect(waveNow().checkedArtifacts).toBe(2);
    expect(waveNow().missingArtifacts).toEqual(["src/ghost.ts"]);
    expect(waveNow().artifactsProbed).toBe(true);
  });

  it("does not ask the filesystem about a URL or a home path", async () => {
    seedWave();
    const asked: string[] = [];
    setWaveArtifactProbeIoForTests({
      canProbe: () => true,
      workingDirOf: () => "C:\\repo",
      exists: async (path) => {
        asked.push(path);
        return path === "C:\\repo\\src/a.ts";
      },
    });
    await settled(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [
          report({
            artifacts: [
              { label: "ci", path: "https://ci.example/run/1" },
              { label: "notes", path: "~/notes.md" },
              { label: "code", path: "src/a.ts:12" },
            ],
          }),
        ],
      }),
    );
    expect(asked).toEqual(["C:\\repo\\src/a.ts"]);
    expect(waveNow().checkedArtifacts).toBe(1);
    expect(waveNow().missingArtifacts).toBeUndefined();
  });

  it("treats a backend that throws as no answer, never as a missing file", async () => {
    // An IPC failure read as "the worker lied" would refuse every accept on
    // every degraded build.
    seedWave();
    setWaveArtifactProbeIoForTests({
      canProbe: () => true,
      workingDirOf: () => "/repo",
      exists: async () => {
        throw new Error("no bridge");
      },
    });
    await settled(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [report({ artifacts: [{ label: "a", path: "src/a.ts" }] })],
      }),
    );
    expect(waveNow().missingArtifacts).toBeUndefined();
  });

  it("stops asking past the ceiling and says how many it looked at", async () => {
    seedWave();
    let asked = 0;
    setWaveArtifactProbeIoForTests({
      canProbe: () => true,
      workingDirOf: () => "/repo",
      exists: async () => {
        asked += 1;
        return true;
      },
    });
    const artifacts = Array.from(
      { length: MAX_CHECKED_ARTIFACT_PATHS + 10 },
      (_, i) => ({ label: `a${i}`, path: `src/a${i}.ts` }),
    );
    await settled(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [report({ artifacts })],
      }),
    );
    expect(asked).toBe(MAX_CHECKED_ARTIFACT_PATHS);
    expect(waveNow().checkedArtifacts).toBe(MAX_CHECKED_ARTIFACT_PATHS);
  });
});
