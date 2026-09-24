import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../types";
import { resolvePreSessionRunSettings } from "../preSessionRunSettings";

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

describe("resolvePreSessionRunSettings", () => {
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
});
