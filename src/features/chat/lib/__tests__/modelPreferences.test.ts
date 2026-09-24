import { beforeEach, describe, expect, it } from "vitest";
import {
  clearStoredModelPreference,
  getStoredModelPreference,
  setStoredModelPreference,
} from "../modelPreferences";
import {
  resolveSessionModelPreference,
  sanitizeSessionModelPreference,
} from "../sessionModelPreference";

const STORAGE_KEY = "distill:preferredModelsByAgent";

function seedStoredPreferences(value: unknown): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

describe("stored model preferences", () => {
  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY);
  });

  it("reads fast mode and the per-model overrides, filing a legacy folded key under its base model", () => {
    seedStoredPreferences({
      "codex-acp": {
        modelId: "gpt-6-astra",
        modelName: "GPT-6-Astra",
        providerId: "codex-acp",
        reasoningEffort: "xhigh",
        fastMode: true,
        byModel: {
          "gpt-5.6-luna[max]": { reasoningEffort: "max" },
          "gpt-5.5": { fastMode: false },
          "gpt-5.3-codex-spark": {},
          "": { reasoningEffort: "low" },
        },
      },
    });

    expect(getStoredModelPreference("codex-acp")).toEqual({
      modelId: "gpt-6-astra",
      modelName: "GPT-6-Astra",
      providerId: "codex-acp",
      reasoningEffort: "xhigh",
      fastMode: true,
      byModel: {
        "gpt-5.6-luna": { reasoningEffort: "max" },
        "gpt-5.5": { fastMode: false },
      },
    });
  });

  it("writes the split form back on the next save", () => {
    seedStoredPreferences({
      "codex-acp": {
        modelId: "gpt-5.6-sol[ultra]",
        modelName: "GPT-5.6-Sol (ultra)",
        providerId: "codex-acp",
      },
    });

    const recovered = getStoredModelPreference("codex-acp");
    expect(recovered).not.toBeNull();
    if (recovered) setStoredModelPreference("codex-acp", recovered);

    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}"),
    ).toEqual({
      "codex-acp": {
        modelId: "gpt-5.6-sol",
        modelName: "GPT-5.6-Sol (ultra)",
        providerId: "codex-acp",
        reasoningEffort: "ultra",
      },
    });

    clearStoredModelPreference("codex-acp");
    expect(getStoredModelPreference("codex-acp")).toBeNull();
  });

  it("keeps the remembered effort and fast mode when only the model is picked again", () => {
    seedStoredPreferences({
      "claude-acp": {
        modelId: "claude-opus-5",
        modelName: "Opus 5",
        providerId: "claude-acp",
        reasoningEffort: "xhigh",
        fastMode: true,
        byModel: { "claude-opus-5": { reasoningEffort: "xhigh" } },
      },
    });

    setStoredModelPreference("claude-acp", {
      modelId: "claude-sonnet-5",
      modelName: "Sonnet 5",
      providerId: "claude-acp",
    });

    expect(getStoredModelPreference("claude-acp")).toEqual({
      modelId: "claude-sonnet-5",
      modelName: "Sonnet 5",
      providerId: "claude-acp",
      reasoningEffort: "xhigh",
      fastMode: true,
      byModel: { "claude-opus-5": { reasoningEffort: "xhigh" } },
    });
  });

  // The regression test for silent loss: the split has to happen before the
  // preference meets the inventory, because both of these drop a model id the
  // harness does not advertise, and they drop it with no error at all.
  describe("a legacy folded preference survives the inventory check", () => {
    it.each([
      ["an inventory of base ids", ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"]],
      [
        "an inventory that still folds the effort in",
        ["gpt-5.6-sol[low]", "gpt-5.6-sol[ultra]", "gpt-6-astra[low]"],
      ],
    ])("against %s", (_label, advertised) => {
      seedStoredPreferences({
        "codex-acp": {
          modelId: "gpt-5.6-sol[ultra]",
          modelName: "GPT-5.6-Sol (ultra)",
          providerId: "codex-acp",
        },
      });

      const preference = resolveSessionModelPreference({
        providerId: "codex-acp",
      });
      expect(preference).toMatchObject({ modelId: "gpt-5.6-sol" });

      expect(
        sanitizeSessionModelPreference(preference, {
          models: advertised.map((id) => ({ id })),
        }),
      ).toEqual(preference);
    });
  });
});
