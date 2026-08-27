import { describe, expect, it } from "vitest";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import {
  personaExecutionTarget,
  personaTargetMigration,
} from "../personaExecutionTarget";

const catalog = (id: string, category: "agent" | "model", aliases?: string[]) =>
  ({
    id,
    displayName: id,
    category,
    aliases,
    description: id,
    setupMethod: "single_api_key",
    group: "default",
  }) as ProviderCatalogEntry;

const context = (
  models: Array<{ id: string; providerId?: string; displayName?: string }> = [],
) => ({
  providers: [
    { id: "goose", label: "Goose" },
    { id: "claude-acp", label: "Claude Code" },
    { id: "codex-acp", label: "Codex" },
  ],
  models,
  catalogEntries: [
    catalog("goose", "agent"),
    catalog("claude-acp", "agent", ["claude"]),
    catalog("codex-acp", "agent", ["codex"]),
    catalog("openai", "model"),
    catalog("anthropic", "model"),
    catalog("databricks_v2", "model", ["databricks"]),
  ],
});

describe("personaExecutionTarget", () => {
  it("returns no override when the agent has no configured target", () => {
    expect(personaExecutionTarget({}, context())).toBeUndefined();
  });

  it("returns the complete saved Goose target without requiring inventory", () => {
    expect(
      personaExecutionTarget(
        { provider: "goose", modelProviderId: "openai", model: "gpt-5" },
        context(),
      ),
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "gpt-5",
      modelName: "gpt-5",
    });
  });

  it("uses an external harness as the runtime provider boundary", () => {
    expect(
      personaExecutionTarget(
        { provider: "claude-acp", model: "sonnet" },
        context([{ id: "sonnet", displayName: "Sonnet" }]),
      ),
    ).toEqual({
      harnessId: "claude-acp",
      modelProviderId: "claude-acp",
      modelId: "sonnet",
      modelName: "Sonnet",
    });
  });

  it("temporarily resolves an incomplete legacy target from one inventory match", () => {
    expect(
      personaExecutionTarget(
        { provider: "goose", model: "shared" },
        context([{ id: "shared", providerId: "openai" }]),
      ),
    ).toEqual({
      harnessId: "goose",
      modelProviderId: "openai",
      modelId: "shared",
      modelName: "shared",
    });
  });

  it("returns no override for a genuinely ambiguous legacy target", () => {
    expect(
      personaExecutionTarget(
        { provider: "goose", model: "shared" },
        context([
          { id: "shared", providerId: "openai" },
          { id: "shared", providerId: "anthropic" },
        ]),
      ),
    ).toBeUndefined();
  });

  // The P0: the agent kept a codex model id the adapter no longer advertises.
  // Goose forwards the id to codex-acp verbatim, codex answers `Invalid
  // params`, and every send in the chat dies on "Failed to set ACP model
  // option". Establishing callers must fall back to the harness' own current
  // model instead of pinning the session to an id nothing can serve.
  it("drops a saved model the harness no longer reports", () => {
    expect(
      personaExecutionTarget(
        { provider: "codex-acp", model: "gpt-5.6-sol[max]" },
        context([
          { id: "gpt-5.6-sol[high]", providerId: "codex-acp" },
          { id: "gpt-5.6-sol[ultra]", providerId: "codex-acp" },
        ]),
        { requireInstalledModel: true },
      ),
    ).toEqual({ harnessId: "codex-acp", modelProviderId: "codex-acp" });
  });

  it("keeps a saved model the harness still reports", () => {
    expect(
      personaExecutionTarget(
        { provider: "codex-acp", model: "gpt-5.6-sol[ultra]" },
        context([
          {
            id: "gpt-5.6-sol[ultra]",
            providerId: "codex-acp",
            displayName: "GPT 5.6 Sol",
          },
        ]),
        { requireInstalledModel: true },
      ),
    ).toEqual({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6-sol[ultra]",
      modelName: "GPT 5.6 Sol",
    });
  });

  // An empty list is a harness that has not answered yet, not a harness that
  // disowns the model. Dropping the model there would retarget every session
  // started before the first inventory refresh.
  it("keeps a saved model while the harness reports nothing at all", () => {
    expect(
      personaExecutionTarget(
        { provider: "codex-acp", model: "gpt-5.6-sol[ultra]" },
        context(),
        { requireInstalledModel: true },
      ),
    ).toEqual({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6-sol[ultra]",
      modelName: "gpt-5.6-sol[ultra]",
    });
  });

  it("leaves an unmatched model alone for readers that only look", () => {
    expect(
      personaExecutionTarget(
        { provider: "codex-acp", model: "gpt-5.6-sol[max]" },
        context([{ id: "gpt-5.6-sol[ultra]", providerId: "codex-acp" }]),
      ),
    ).toEqual({
      harnessId: "codex-acp",
      modelProviderId: "codex-acp",
      modelId: "gpt-5.6-sol[max]",
      modelName: "gpt-5.6-sol[max]",
    });
  });
});

describe("personaTargetMigration", () => {
  it("persists the known internal Databricks v1 to v2 repair", () => {
    expect(
      personaTargetMigration(
        { provider: "goose", model: "goose-claude-fable-5" },
        context([
          {
            id: "goose-claude-fable-5",
            providerId: "databricks",
          },
          {
            id: "goose-claude-fable-5",
            providerId: "databricks_v2",
          },
        ]),
      ),
    ).toEqual({
      provider: "goose",
      modelProviderId: "databricks_v2",
      model: "goose-claude-fable-5",
    });
  });

  it("canonicalizes a legacy provider stored in the harness field", () => {
    expect(
      personaTargetMigration(
        { provider: "databricks", model: "goose-gpt-5-5" },
        context(),
      ),
    ).toEqual({
      provider: "goose",
      modelProviderId: "databricks_v2",
      model: "goose-gpt-5-5",
    });
  });

  it("clears an ambiguous target that cannot be repaired deterministically", () => {
    expect(
      personaTargetMigration(
        { provider: "goose", model: "shared" },
        context([
          { id: "shared", providerId: "openai" },
          { id: "shared", providerId: "anthropic" },
        ]),
      ),
    ).toEqual({ provider: null, modelProviderId: null, model: null });
  });

  it("preserves an unmatched legacy target when inventory may be incomplete", () => {
    expect(
      personaTargetMigration(
        { provider: "goose", model: "temporarily-unavailable" },
        context(),
      ),
    ).toBeNull();
  });

  it("preserves a complete target even when its provider is disconnected", () => {
    expect(
      personaTargetMigration(
        {
          provider: "goose",
          modelProviderId: "openai",
          model: "future-model",
        },
        context(),
      ),
    ).toBeNull();
  });
});
