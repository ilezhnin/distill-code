import { afterEach, describe, expect, it } from "vitest";

import type { StructuredReport } from "./types";
import {
  MAX_CHECKED_ARTIFACT_PATHS,
  artifactPathsOf,
  resetWaveArtifactProbeForTests,
  resolveArtifactPath,
  startWaveArtifactProbe,
  waveArtifactFactsOf,
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

describe("artifactPathsOf", () => {
  it("collects paths across reports, in the order they were named", () => {
    const paths = artifactPathsOf([
      report({ artifacts: [{ label: "a", path: "src/a.ts" }] }),
      report({ artifacts: [{ label: "b", path: "src/b.ts" }] }),
    ]);
    expect(paths).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("asks about each path once", () => {
    const paths = artifactPathsOf([
      report({ artifacts: [{ label: "a", path: "src/a.ts" }] }),
      report({ artifacts: [{ label: "again", path: "src/a.ts" }] }),
    ]);
    expect(paths).toEqual(["src/a.ts"]);
  });

  it("ignores an artifact that is a link rather than a file", () => {
    // A url artifact does not live on this disk, and calling it missing would
    // be a false accusation from a check that never looked.
    const paths = artifactPathsOf([
      report({ artifacts: [{ label: "run", url: "https://ci/1" }] }),
    ]);
    expect(paths).toEqual([]);
  });
});

describe("resolveArtifactPath", () => {
  it("reads a relative path against the conductor's working folder", () => {
    expect(resolveArtifactPath("src/a.ts", "/repo")).toBe("/repo/src/a.ts");
    expect(resolveArtifactPath("./src/a.ts", "/repo")).toBe("/repo/src/a.ts");
  });

  it("keeps the working folder's own separator on Windows", () => {
    expect(resolveArtifactPath("src/a.ts", "C:\\repo")).toBe(
      "C:\\repo\\src/a.ts",
    );
  });

  it("leaves an already-answerable path alone", () => {
    expect(resolveArtifactPath("/etc/hosts", "/repo")).toBe("/etc/hosts");
    expect(resolveArtifactPath("~/notes.md", "/repo")).toBe("~/notes.md");
    expect(resolveArtifactPath("C:\\x\\y.txt", "/repo")).toBe("C:\\x\\y.txt");
    expect(resolveArtifactPath("https://ci/1", "/repo")).toBe("https://ci/1");
  });

  it("passes the path through when there is no working folder", () => {
    expect(resolveArtifactPath("src/a.ts", undefined)).toBe("src/a.ts");
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

  it("records a clean check as checked-and-nothing-missing", async () => {
    seedWave();
    setWaveArtifactProbeIoForTests({
      canProbe: () => true,
      workingDirOf: () => "/repo",
      exists: async () => true,
    });
    await settled(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [report({ artifacts: [{ label: "a", path: "src/a.ts" }] })],
      }),
    );
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

  it("does not start when there is nothing to ask about", () => {
    seedWave();
    setWaveArtifactProbeIoForTests({ canProbe: () => true });
    expect(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [report()],
      }),
    ).toBe(false);
  });

  it("does not start when there is no Tauri to ask", () => {
    seedWave();
    setWaveArtifactProbeIoForTests({ canProbe: () => false });
    expect(
      startWaveArtifactProbe({
        waveId: "w1",
        conductorSessionId: "c1",
        reports: [report({ artifacts: [{ label: "a", path: "src/a.ts" }] })],
      }),
    ).toBe(false);
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

describe("waveArtifactFactsOf", () => {
  it("says nothing when nothing was checked", () => {
    // "Nothing was checked" and "everything checked out" are different
    // answers, and only the second is evidence.
    expect(waveArtifactFactsOf({})).toBeUndefined();
    expect(waveArtifactFactsOf({ checkedArtifacts: 0 })).toBeUndefined();
  });

  it("reports a clean check as evidence", () => {
    expect(waveArtifactFactsOf({ checkedArtifacts: 3 })).toEqual({
      checked: 3,
      missing: [],
    });
  });

  it("carries the missing paths through", () => {
    expect(
      waveArtifactFactsOf({
        checkedArtifacts: 3,
        missingArtifacts: ["src/ghost.ts"],
      }),
    ).toEqual({ checked: 3, missing: ["src/ghost.ts"] });
  });
});
