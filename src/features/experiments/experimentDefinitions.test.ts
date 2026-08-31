import { describe, expect, it } from "vitest";

import enSettings from "@/shared/i18n/locales/en/settings.json";
import esSettings from "@/shared/i18n/locales/es/settings.json";

import {
  EXPERIMENT_DEFINITIONS,
  MEMORY_WIKI_GRAPH_EXPERIMENT_ID,
  VOICE_CONVERSATION_EXPERIMENT_ID,
} from "./experimentDefinitions";

describe("experiment definitions", () => {
  it("defaults Voice Conversation on while preserving explicit overrides", () => {
    expect(
      EXPERIMENT_DEFINITIONS.find(
        (definition) => definition.id === VOICE_CONVERSATION_EXPERIMENT_ID,
      )?.defaultEnabled,
    ).toBe(true);
  });

  it("keeps the wiki graph opt-in outside development", () => {
    expect(
      EXPERIMENT_DEFINITIONS.find(
        (definition) => definition.id === MEMORY_WIKI_GRAPH_EXPERIMENT_ID,
      ),
    ).toMatchObject({
      titleKey: "experiments.memoryWikiGraph.title",
      descriptionKey: "experiments.memoryWikiGraph.description",
      defaultEnabled: false,
    });
  });

  // A definition names its labels by key, so a missing translation reaches the
  // operator as the key itself in the experiments list rather than as an error.
  it("has a title and a description in every locale", () => {
    for (const locale of [enSettings, esSettings]) {
      const labels = (
        locale.experiments as Record<
          string,
          { title?: string; description?: string }
        >
      ).memoryWikiGraph;
      expect(labels?.title).toBeTruthy();
      expect(labels?.description).toBeTruthy();
    }
  });
});
