import { afterEach, describe, expect, it } from "vitest";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderModelCacheStore } from "@/features/providers/stores/providerModelCacheStore";

import type { ModelOption } from "@/features/chat/types";

import type { WaveStep } from "./distillWave";
import {
  checkWaveStepRunSettings,
  planWaveStepRunSettings,
  resetWaveStepTargetIoForTests,
  resolveExplicitWaveStepModel,
  setWaveStepTargetIoForTests,
} from "./waveStepTarget";

function installRows(
  byHarness: Record<string, Partial<ModelOption>[]>,
  conductorTarget?: { harnessId: string; modelId: string },
): void {
  setWaveStepTargetIoForTests({
    personas: () => [],
    providers: () =>
      Object.keys(byHarness).map((id) => ({ id, label: id })) as never,
    modelsForHarness: (harnessId) =>
      (byHarness[harnessId] ?? []).map((row) => ({
        displayName: row.id,
        ...row,
      })) as never,
    rateLimits: () => [] as never,
    conductorTarget: () =>
      (conductorTarget
        ? { ...conductorTarget, modelProviderId: conductorTarget.harnessId }
        : undefined) as never,
  });
}

function planStep(fields: Partial<WaveStep>): WaveStep {
  return { role: "brigade", subtask: "Rename it", access: [], ...fields };
}

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

  it("takes an exact id, even one shaped like a legacy folded id", () => {
    installModels({ "codex-acp": ["gpt-5.6-sol[low]", "gpt-5.6-sol[ultra]"] });
    const resolved = resolveExplicitWaveStepModel("gpt-5.6-sol[ultra]");
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.target.modelId).toBe("gpt-5.6-sol[ultra]");
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
    installModels({ "codex-acp": ["gpt-5.6-sol", "claude-opus-5"] });
    for (const requested of ["5", ".", "x"]) {
      const resolved = resolveExplicitWaveStepModel(requested);
      expect(resolved.ok).toBe(false);
      expect(resolved.ok === false && resolved.detail).toContain("too vague");
    }
  });

  it("never splits a context-lane id like opus[1m]", () => {
    installModels({ "claude-acp": ["opus", "opus[1m]"] });
    const exact = resolveExplicitWaveStepModel("opus[1m]");
    expect(exact.ok && exact.target.modelId).toBe("opus[1m]");
    expect(exact.ok && exact.legacyEffort).toBeUndefined();

    // With no such row, "[1m]" is still not read as an effort to strip off:
    // the step does not quietly run on the plain model.
    installModels({ "claude-acp": ["claude-opus-5"] });
    const missing = resolveExplicitWaveStepModel("opus[1m]");
    expect(missing.ok).toBe(false);
  });
});

describe("checkWaveStepRunSettings", () => {
  afterEach(() => {
    resetWaveStepTargetIoForTests();
  });

  const grok: Partial<ModelOption> = {
    id: "grok-4-6",
    displayName: "Grok 4.6",
    efforts: [{ id: "low" }, { id: "high" }] as never,
    supportsFast: false,
  };

  it("refuses an effort the model does not offer, naming the ones it does", () => {
    installRows({ "grok-acp": [grok] });
    const check = checkWaveStepRunSettings(
      planStep({ model: "grok", effort: "xhigh" }),
      "conductor-1",
    );
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.detail).toContain('"xhigh"');
    expect(check.ok === false && check.detail).toContain("it offers low, high");
  });

  it("refuses fast mode on a model that has none", () => {
    installRows({ "grok-acp": [grok] });
    const check = checkWaveStepRunSettings(
      planStep({ model: "grok", fast: true }),
      "conductor-1",
    );
    expect(check.ok === false && check.detail).toContain("has no fast mode");
    // Turning fast mode off asks nothing of the model.
    expect(
      checkWaveStepRunSettings(
        planStep({ model: "grok", fast: false }),
        "conductor-1",
      ),
    ).toEqual({ ok: true });
  });

  it("judges a legacy effort inside the model string, and lets the step's own effort win", () => {
    installRows({
      "codex-acp": [{ id: "gpt-5.6-sol", efforts: [{ id: "high" }] as never }],
    });
    expect(
      checkWaveStepRunSettings(
        planStep({ model: "gpt-5.6-sol[low]" }),
        "conductor-1",
      ).ok,
    ).toBe(false);
    expect(
      checkWaveStepRunSettings(
        planStep({ model: "gpt-5.6-sol[low]", effort: "high" }),
        "conductor-1",
      ),
    ).toEqual({ ok: true });
  });
});

describe("planWaveStepRunSettings", () => {
  it("prefers the step's own effort over a legacy one and the ranking's, in the model's spelling", () => {
    const judged = planWaveStepRunSettings({
      step: { effort: "XHigh" },
      legacyEffort: "low",
      ranked: { effort: "medium", fast: true },
      model: {
        id: "claude-opus-5",
        name: "Opus 5",
        efforts: [{ id: "xhigh", name: "Extra high" }],
      } as never,
    });
    expect(judged.runSettings).toEqual({ effort: "xhigh", fast: true });
    expect(judged.effortApplied).toBe(true);
  });
});

describe("a plan-named model while every provider's poll has failed", () => {
  afterEach(() => {
    resetWaveStepTargetIoForTests();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
    useAgentStore.setState({ providers: [] as never });
  });

  /**
   * Recorded behaviour change (review T4a #8), pinned here because nothing else
   * covers it: the routing seam reports no models for a harness whose last poll
   * failed, and the explicit-model check reads the same seam. A transient outage
   * across every provider therefore refuses the whole plan where it used to
   * admit it and let the step inherit the conductor's model.
   *
   * That is the failure WAVES asks for — a step must not run on a model the
   * plan did not name — and it is loud and retryable rather than silent. It
   * costs a replan during an outage, which is the trade being recorded.
   */
  it("refuses the plan rather than letting the step inherit the conductor", () => {
    useAgentStore.setState({
      providers: [{ id: "claude-acp", label: "Claude Code" }] as never,
    });
    // The entry still lists the model — a failed poll keeps the previous
    // payload — but says the poll failed.
    useProviderModelCacheStore.setState({
      providers: new Map([
        [
          "claude-acp",
          {
            providerId: "claude-acp",
            models: [{ id: "claude-opus-5", displayName: "Opus 5" }],
            fetchedAt: Date.now(),
            error: "bridge not installed",
            outcome: "failed",
          },
        ],
      ]) as never,
    });

    const resolved = resolveExplicitWaveStepModel("claude-opus-5");

    expect(resolved.ok).toBe(false);
    expect(resolved.ok === false && resolved.detail).toContain(
      "cannot be checked",
    );
  });
});
