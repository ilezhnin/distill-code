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

  it("reads the effort out of a preference that folded it into the model id", () => {
    seedStoredPreferences({
      "codex-acp": {
        modelId: "gpt-5.6-sol[ultra]",
        modelName: "GPT-5.6-Sol (ultra)",
        providerId: "codex-acp",
      },
    });

    expect(getStoredModelPreference("codex-acp")).toEqual({
      modelId: "gpt-5.6-sol",
      modelName: "GPT-5.6-Sol (ultra)",
      providerId: "codex-acp",
      reasoningEffort: "ultra",
    });
  });

  it("lets an explicitly stored effort win over a conflicting suffix", () => {
    seedStoredPreferences({
      "codex-acp": {
        modelId: "gpt-5.6-sol[low]",
        modelName: "GPT-5.6-Sol",
        providerId: "codex-acp",
        reasoningEffort: "ultra",
      },
    });

    expect(getStoredModelPreference("codex-acp")).toMatchObject({
      modelId: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    });
  });

  it("keeps a context lane as part of the model id", () => {
    seedStoredPreferences({
      "claude-acp": {
        modelId: "opus[1m]",
        modelName: "Opus 5",
        providerId: "claude-acp",
      },
    });

    expect(getStoredModelPreference("claude-acp")).toEqual({
      modelId: "opus[1m]",
      modelName: "Opus 5",
      providerId: "claude-acp",
    });
  });

  it("reads fast mode and the per-model overrides when they are there", () => {
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

  it("ignores run settings that are not written in their own shape", () => {
    seedStoredPreferences({
      "codex-acp": {
        modelId: "gpt-5.5",
        modelName: "GPT-5.5",
        providerId: "codex-acp",
        reasoningEffort: "   ",
        fastMode: "yes",
        byModel: "high",
      },
    });

    expect(getStoredModelPreference("codex-acp")).toEqual({
      modelId: "gpt-5.5",
      modelName: "GPT-5.5",
      providerId: "codex-acp",
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

  // The regression test for silent loss: the split has to happen before the
  // preference meets the inventory, because both of these drop a model id the
  // harness does not advertise, and they drop it with no error at all.
  describe("survives the inventory check", () => {
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

    it("still drops a model the harness no longer serves", () => {
      seedStoredPreferences({
        "codex-acp": {
          modelId: "gpt-5.4-mini[low]",
          modelName: "GPT-5.4-Mini",
          providerId: "codex-acp",
        },
      });

      const preference = resolveSessionModelPreference({
        providerId: "codex-acp",
      });

      expect(
        sanitizeSessionModelPreference(preference, {
          models: [{ id: "gpt-6-astra" }, { id: "gpt-5.6-sol" }],
        }),
      ).toEqual({ providerId: "codex-acp" });
    });
  });
});
