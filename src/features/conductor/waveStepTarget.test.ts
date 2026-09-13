import { afterEach, describe, expect, it } from "vitest";

import {
  resetWaveStepTargetIoForTests,
  resolveExplicitWaveStepModel,
  setWaveStepTargetIoForTests,
} from "./waveStepTarget";

function installModels(byHarness: Record<string, string[]>): void {
  setWaveStepTargetIoForTests({
    personas: () => [],
    providers: () =>
      Object.keys(byHarness).map((id) => ({ id, label: id })) as never,
    modelsForHarness: (harnessId) =>
      (byHarness[harnessId] ?? []).map((id) => ({
        id,
        displayName: id,
      })) as never,
    rateLimits: () => [] as never,
  });
}

describe("resolveExplicitWaveStepModel", () => {
  afterEach(() => {
    resetWaveStepTargetIoForTests();
  });

  it("takes an exact id, whatever else it looks like", () => {
    installModels({ "codex-acp": ["gpt-5.6-sol[low]", "gpt-5.6-sol[ultra]"] });
    const resolved = resolveExplicitWaveStepModel("gpt-5.6-sol[ultra]");
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.target.modelId).toBe("gpt-5.6-sol[ultra]");
  });

  it("still matches a partial name that means exactly one model", () => {
    installModels({ "claude-acp": ["claude-opus-5", "claude-fable-5-1"] });
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.target.modelId).toBe("claude-opus-5");
  });

  it("refuses a name that matches several reasoning tiers of one model", () => {
    // WAVES: a step naming a model the harness does not serve must refuse the
    // plan rather than run on something else. Inventories list tiers
    // ascending, so "first hit wins" ran the step at the weakest one — the
    // exact shape of the L1 incident, arrived at from the other direction.
    installModels({
      "codex-acp": [
        "gpt-5.6-sol[low]",
        "gpt-5.6-sol[medium]",
        "gpt-5.6-sol[ultra]",
      ],
    });
    const resolved = resolveExplicitWaveStepModel("gpt-5");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.detail).toContain(
      "gpt-5.6-sol[low]",
    );
    expect(resolved.ok === false && resolved.detail).toContain(
      "several reasoning tiers",
    );
  });

  it("honours a tier the plan named", () => {
    installModels({
      "codex-acp": ["gpt-5.6-sol[low]", "gpt-5.6-sol[medium]"],
    });
    const resolved = resolveExplicitWaveStepModel("gpt-5[medium]");
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.target.modelId).toBe("gpt-5.6-sol[medium]");
  });

  it("refuses a name that matches two different models", () => {
    installModels({
      "claude-acp": ["claude-opus-5"],
      "codex-acp": ["gpt-opus-preview"],
    });
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.detail).toContain(
      "more than one installed model",
    );
  });

  it("refuses a degenerate name instead of taking the first id", () => {
    installModels({ "codex-acp": ["gpt-5.6-sol[low]", "claude-opus-5"] });
    for (const requested of ["5", ".", "x"]) {
      const resolved = resolveExplicitWaveStepModel(requested);
      expect(resolved.ok).toBe(false);
      expect(resolved.ok === false && resolved.detail).toContain("too vague");
    }
  });

  it("takes one model that two providers both list", () => {
    // Not an ambiguity about *which model runs*, which is all the plan named.
    installModels({
      "claude-acp": ["claude-opus-5"],
      "other-acp": ["claude-opus-5"],
    });
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.target.modelId).toBe("claude-opus-5");
  });

  it("refuses when nothing is installed at all", () => {
    installModels({});
    const resolved = resolveExplicitWaveStepModel("opus");
    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.detail).toContain(
      "no agent provider",
    );
  });
});
