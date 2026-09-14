import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../types";
import {
  findModelOption,
  PRE_SESSION_EFFORT_CONFIG_ID,
  resolvePreSessionRunSettings,
} from "../preSessionRunSettings";

const opus5: ModelOption = {
  id: "claude-opus-5",
  name: "Opus 5",
  providerId: "claude-acp",
  efforts: [
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "xhigh", name: "Extra high" },
    { id: "max", name: "Max" },
  ],
  defaultEffort: "high",
  supportsFast: true,
  capabilitySource: "probed",
};

const opus46: ModelOption = {
  id: "claude-opus-4-6",
  name: "Opus 4.6",
  providerId: "claude-acp",
  efforts: [
    { id: "default", name: "Default" },
    { id: "low", name: "Low" },
    { id: "medium", name: "Medium" },
    { id: "high", name: "High" },
    { id: "max", name: "Max" },
  ],
  defaultEffort: "default",
  supportsFast: false,
  capabilitySource: "declared",
};

const haiku: ModelOption = {
  id: "claude-haiku-4-5",
  name: "Haiku 4.5",
  providerId: "claude-acp",
  efforts: [],
  supportsFast: false,
  capabilitySource: "probed",
};

describe("resolvePreSessionRunSettings", () => {
  it("shows the model's own menu at its default and records no intent when nothing was chosen", () => {
    const resolved = resolvePreSessionRunSettings({ model: opus5 });

    expect(resolved.reasoningEffort).toEqual({
      configId: PRE_SESSION_EFFORT_CONFIG_ID,
      currentValue: "high",
      options: opus5.efforts,
    });
    expect(resolved.fast).toBe(false);
    expect(resolved.intent).toBeUndefined();
    expect(resolved.notice).toBeNull();
  });

  it("prefers the composer's choice, then the model's remembered value, then the agent's", () => {
    const preference = {
      modelId: "claude-opus-5",
      modelName: "Opus 5",
      providerId: "claude-acp",
      reasoningEffort: "medium",
      fastMode: true,
      byModel: { "claude-opus-5": { reasoningEffort: "xhigh" } },
    };

    expect(
      resolvePreSessionRunSettings({
        model: opus5,
        desired: { effort: "max" },
        preference,
      }).intent,
    ).toEqual({ effort: "max", fast: true });
    expect(
      resolvePreSessionRunSettings({ model: opus5, preference }).intent,
    ).toEqual({ effort: "xhigh", fast: true });
    expect(
      resolvePreSessionRunSettings({
        model: opus5,
        preference: { ...preference, byModel: undefined },
      }).intent,
    ).toEqual({ effort: "medium", fast: true });
  });

  it("does not carry a remembered value onto a model that cannot honour it", () => {
    const resolved = resolvePreSessionRunSettings({
      model: opus46,
      preference: {
        modelId: "claude-opus-5",
        modelName: "Opus 5",
        providerId: "claude-acp",
        reasoningEffort: "xhigh",
        fastMode: true,
      },
    });

    expect(resolved.intent).toBeUndefined();
    expect(resolved.reasoningEffort?.currentValue).toBe("default");
    expect(resolved.notice).toBeNull();
  });

  it("keeps an explicit choice the model lacks as intent and says what runs instead", () => {
    const resolved = resolvePreSessionRunSettings({
      model: opus46,
      desired: { effort: "xhigh" },
    });

    expect(resolved.intent).toEqual({ effort: "xhigh" });
    expect(resolved.reasoningEffort?.currentValue).toBe("default");
    expect(resolved.notice).toEqual({
      kind: "effort",
      wanted: "xhigh",
      actual: "default",
      modelName: "Opus 4.6",
    });
  });

  it("still applies what is remembered for a model whose inventory row is not known yet", () => {
    const resolved = resolvePreSessionRunSettings({
      modelId: "claude-opus-5",
      preference: {
        modelId: "claude-opus-5",
        modelName: "Opus 5",
        providerId: "claude-acp",
        reasoningEffort: "medium",
        byModel: {
          "claude-opus-5": { reasoningEffort: "xhigh", fastMode: true },
        },
      },
    });

    // The per-model value is that model's own; the agent-level one is only
    // taken where the model is known to offer it.
    expect(resolved.intent).toEqual({ effort: "xhigh", fast: true });
    expect(resolved.reasoningEffort).toBeUndefined();
  });

  it("offers no effort menu for a model whose inventory row has no efforts", () => {
    expect(
      resolvePreSessionRunSettings({ model: haiku }).reasoningEffort,
    ).toBeUndefined();
    expect(
      resolvePreSessionRunSettings({ model: { id: "unknown", name: "?" } })
        .reasoningEffort,
    ).toBeUndefined();
  });
});

describe("findModelOption", () => {
  it("finds the row a legacy folded id names", () => {
    expect(
      findModelOption([opus5, opus46], "claude-opus-4-6", "claude-acp"),
    ).toBe(opus46);
    expect(
      findModelOption(
        [{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" }],
        "gpt-5.6-sol[xhigh]",
      )?.id,
    ).toBe("gpt-5.6-sol");
  });
});
