import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/features/chat/types";
import type {
  ProviderInventoryModel,
  ProviderInventoryModelEffort,
} from "@/shared/api/hostTypes";
import { subscribeProviderModelInventoryInvalidated } from "../lib/providerModelInventoryEvents";
import {
  PICKER_REFRESH_FLOOR_MS,
  useProviderModelCacheStore,
} from "./providerModelCacheStore";

const CACHE_KEY = "distill:providerModelCache:v2";
const CACHE_SCHEMA_VERSION = 3;

const mocks = vi.hoisted(() => ({
  getClient: vi.fn(),
  supportedModelsList: vi.fn(),
}));

vi.mock("@/shared/api/acpConnection", () => ({
  getClient: () => mocks.getClient(),
}));

function seededModel(overrides: Partial<ModelOption> = {}): ModelOption {
  return {
    id: "seeded-model",
    name: "Seeded model",
    displayName: "Seeded model",
    providerId: "databricks_v2",
    providerName: "Databricks",
    recommended: false,
    featured: false,
    ...overrides,
  };
}

const CLAUDE_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];
/** The 4.6-class models have no xhigh. */
const CLAUDE_EFFORTS_NO_XHIGH = ["default", "low", "medium", "high", "max"];

/** Effort values as the host lists them: its own value ids, plus a name. */
function efforts(values: string[]): ProviderInventoryModelEffort[] {
  return values.map((value) => ({
    value,
    name: `${value.charAt(0).toUpperCase()}${value.slice(1)}`,
    description: null,
  }));
}

/**
 * A row in the shape the host answers with, defaulting to a model nobody has
 * asked about: filed on the main page, capabilities unknown.
 */
function hostRow(
  id: string,
  overrides: Partial<ProviderInventoryModel> = {},
): ProviderInventoryModel {
  return {
    id,
    name: id,
    description: null,
    group: "main",
    order: 1000,
    aliasOf: null,
    efforts: [],
    defaultEffort: null,
    supportsFast: null,
    opensOnModel: false,
    capabilitySource: "unknown",
    ...overrides,
  };
}

describe("providerModelCacheStore", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    window.localStorage.clear();
    useProviderModelCacheStore.setState({
      providers: new Map(),
      refreshingProviderIds: new Set(),
      runtimeManagedProviderIds: new Set(),
    });
    mocks.getClient.mockResolvedValue({
      host: {
        providersSupportedModelsList: mocks.supportedModelsList,
      },
    });
  });

  it("seeds runtime models as authoritative runtime-managed entries", async () => {
    const model = seededModel({
      contextLimit: 128000,
      recommended: true,
      featured: true,
      sortOrder: 0,
    });

    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));
    await useProviderModelCacheStore
      .getState()
      .refreshAllModelProviders(["databricks_v2"]);
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.runtimeManaged).toBe(true);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([model]);
    expect(mocks.supportedModelsList).not.toHaveBeenCalled();
  });

  it("preserves runtime-managed models after invalidation and forced refresh", async () => {
    const model = seededModel({
      contextLimit: 128000,
      recommended: true,
      featured: true,
      sortOrder: 0,
    });

    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));
    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const entry = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(entry?.runtimeManaged).toBe(true);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([model]);
    expect(mocks.supportedModelsList).not.toHaveBeenCalled();
  });

  it("keeps refreshable runtime models provisional until discovery succeeds", async () => {
    const configuredModel = seededModel({ id: "goose-gpt-5-5" });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);

    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [{ id: "goose-gpt-5-5" }, { id: "goose-claude-fable" }],
    });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(true);
  });

  it.each([
    {
      label: "stale",
      fetchedAt: 1,
      force: false,
      error: undefined,
    },
    {
      label: "fresh forced with an error",
      fetchedAt: Date.now(),
      force: true,
      error: "authentication failed",
    },
    {
      label: "retryable with an error",
      fetchedAt: 0,
      force: false,
      error: "authentication failed",
    },
  ])("preserves a $label populated cache and retries after empty discovery", async ({
    fetchedAt,
    force,
    error,
  }) => {
    const cachedEntry = {
      providerId: "openrouter",
      models: [
        seededModel({
          providerId: "openrouter",
          providerName: "OpenRouter",
        }),
      ],
      fetchedAt,
      schemaVersion: CACHE_SCHEMA_VERSION,
      ...(error ? { error } : {}),
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify([cachedEntry]));
    useProviderModelCacheStore.getState().loadPersisted();
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [{ id: "replacement-model" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter", { force });

    // The empty answer is still recorded as an outcome: the entry says which
    // kind of empty it is, and the retry timing is what stays unchanged.
    const retryableEntry = { ...cachedEntry, fetchedAt: 0, outcome: "empty" };
    delete retryableEntry.error;
    expect(
      useProviderModelCacheStore.getState().providers.get("openrouter"),
    ).toEqual(retryableEntry);
    expect(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "[]")).toEqual([
      retryableEntry,
    ]);
    expect(useProviderModelCacheStore.getState().getError("openrouter")).toBe(
      null,
    );

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["replacement-model"]);
  });

  it("keeps configured models provisional and retryable after empty discovery", async () => {
    const configuredModel = seededModel({
      providerId: "openrouter",
      providerName: "OpenRouter",
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["openrouter", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [{ id: "discovered-model" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    const provisionalEntry = useProviderModelCacheStore
      .getState()
      .providers.get("openrouter");
    expect(provisionalEntry).toEqual({
      providerId: "openrouter",
      models: [configuredModel],
      configuredModels: [configuredModel],
      fetchedAt: 0,
      schemaVersion: CACHE_SCHEMA_VERSION,
      outcome: "empty",
    });
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["discovered-model", configuredModel.id]);
  });

  it("retries after an empty refresh with no cached entry", async () => {
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [{ id: "openrouter-model" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");
    // The provider answered with nothing, which is a fact worth keeping even
    // with no models to cache: the entry exists solely to record the outcome,
    // and lists nothing, so the retry below still happens.
    expect(
      useProviderModelCacheStore.getState().providers.get("openrouter"),
    ).toEqual({
      providerId: "openrouter",
      models: [],
      fetchedAt: 0,
      schemaVersion: CACHE_SCHEMA_VERSION,
      outcome: "empty",
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["openrouter-model"]);
  });

  it("recovers from a persisted fresh-empty cache entry", async () => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          providerId: "openrouter",
          models: [],
          fetchedAt: Date.now(),
          schemaVersion: CACHE_SCHEMA_VERSION,
        },
      ]),
    );
    useProviderModelCacheStore.getState().loadPersisted();
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [] })
      .mockResolvedValueOnce({ models: [{ id: "openrouter-model" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("openrouter");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["openrouter-model"]);
  });

  it("preserves bundled metadata while refreshing the available model list", async () => {
    const configuredModel = seededModel({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      displayName: "GPT-5.6 Sol",
      recommended: true,
      featured: true,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [
        { id: "goose-gpt-5-5" },
        { id: "goose-gpt-5-6-sol" },
        { id: "goose-claude-opus-4" },
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(mocks.supportedModelsList).toHaveBeenCalledWith({
      providerId: "databricks_v2",
    });
    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("databricks_v2");
    expect(models).toHaveLength(3);
    expect(models.find((model) => model.id === "goose-gpt-5-5")).toEqual(
      expect.objectContaining({
        id: "goose-gpt-5-5",
        recommended: true,
        featured: false,
      }),
    );
    expect(models.find((model) => model.id === "goose-gpt-5-6-sol")).toEqual(
      expect.objectContaining(configuredModel),
    );
    expect(models.find((model) => model.id === "goose-claude-opus-4")).toEqual(
      expect.objectContaining({
        id: "goose-claude-opus-4",
        recommended: true,
        featured: false,
      }),
    );
  });

  it("keeps configured models that are missing from the provider model list", async () => {
    const configuredModel = seededModel({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      displayName: "GPT-5.6 Sol",
      recommended: true,
      featured: true,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [{ id: "goose-gpt-5-5" }],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("databricks_v2");
    expect(models.map((model) => model.id)).toEqual([
      "goose-gpt-5-5",
      "goose-gpt-5-6-sol",
    ]);
    expect(models.find((model) => model.id === "goose-gpt-5-6-sol")).toEqual(
      expect.objectContaining(configuredModel),
    );
  });

  it("keeps configured models after a failed refresh and retry", async () => {
    const configuredModel = seededModel({
      id: "goose-gpt-5-6-sol",
      name: "GPT-5.6 Sol",
      displayName: "GPT-5.6 Sol",
      recommended: true,
    });
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [configuredModel]]]), {
        runtimeManagedProviderIds: new Set(),
      });
    mocks.supportedModelsList
      .mockRejectedValueOnce(new Error("not authenticated"))
      .mockResolvedValueOnce({ models: [{ id: "goose-gpt-5-5" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5", "goose-gpt-5-6-sol"]);
  });

  it("removes stale runtime-managed providers when runtime config changes", () => {
    const model = seededModel();

    useProviderModelCacheStore.getState().seedRuntimeModels(
      new Map([
        ["databricks_v2", [model]],
        [
          "block_openai_compatible",
          [
            {
              ...model,
              providerId: "block_openai_compatible",
              providerName: "Block AI Gateway",
            },
          ],
        ],
      ]),
    );
    useProviderModelCacheStore
      .getState()
      .seedRuntimeModels(new Map([["databricks_v2", [model]]]));

    expect(
      useProviderModelCacheStore
        .getState()
        .providers.has("block_openai_compatible"),
    ).toBe(false);
    expect(
      useProviderModelCacheStore.getState().providers.has("databricks_v2"),
    ).toBe(true);
  });

  it("runs a forced refresh after an in-flight refresh finishes", async () => {
    let rejectInitialRefresh!: (error: Error) => void;
    const initialRefresh = new Promise<{ models: { id: string }[] }>(
      (_resolve, reject) => {
        rejectInitialRefresh = reject;
      },
    );
    mocks.supportedModelsList
      .mockReturnValueOnce(initialRefresh)
      .mockResolvedValueOnce({
        models: [{ id: "goose-gpt-5-5" }],
      });

    const firstRefreshPromise = useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    await waitFor(() =>
      expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1),
    );

    const forcedRefreshPromise = useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    rejectInitialRefresh(new Error("not authenticated"));

    await Promise.all([firstRefreshPromise, forcedRefreshPromise]);

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5"]);
    expect(
      useProviderModelCacheStore.getState().getError("databricks_v2"),
    ).toBe(null);
  });

  it("does not write stale refresh results after invalidation", async () => {
    let resolveInitialRefresh!: (value: { models: { id: string }[] }) => void;
    const initialRefresh = new Promise<{ models: { id: string }[] }>(
      (resolve) => {
        resolveInitialRefresh = resolve;
      },
    );
    mocks.supportedModelsList.mockReturnValueOnce(initialRefresh);

    const refreshPromise = useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    await waitFor(() =>
      expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1),
    );

    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");
    resolveInitialRefresh({ models: [{ id: "goose-gpt-5-5" }] });
    await refreshPromise;

    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([]);
  });

  it("records which of the three answers the last poll gave", async () => {
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [{ id: "openrouter-model" }] })
      .mockResolvedValueOnce({ models: [] })
      .mockRejectedValueOnce(new Error("bridge is not running"));

    const pollOnce = async () => {
      await useProviderModelCacheStore
        .getState()
        .refreshProviderModels("openrouter", { force: true });
      return useProviderModelCacheStore.getState().providers.get("openrouter");
    };

    // Three different situations that all reach the UI as an empty list unless
    // the entry says which one happened.
    expect((await pollOnce())?.outcome).toBe("models");
    expect((await pollOnce())?.outcome).toBe("empty");

    const failed = await pollOnce();
    expect(failed?.outcome).toBe("failed");
    expect(failed?.error).toBe("bridge is not running");

    // Recording the outcome must not change what the picker gets back: the
    // last usable payload is still there, still not authoritative.
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("openrouter")
        .map((model) => model.id),
    ).toEqual(["openrouter-model"]);
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("openrouter"),
    ).toBe(false);
  });

  it("keeps the last known model list when credentials are re-entered", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [{ id: "goose-gpt-5-5" }],
    });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");

    // A re-login says "this may be out of date", not "there is nothing": the
    // list stays visible to the picker while it is re-polled.
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5"]);
    // ...but nothing downstream may treat it as fact until a poll confirms it.
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("databricks_v2"),
    ).toBe(false);
    expect(
      useProviderModelCacheStore.getState().providers.get("databricks_v2")
        ?.fetchedAt,
    ).toBe(0);

    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [{ id: "goose-gpt-5-5" }, { id: "goose-claude-opus-4" }],
    });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2")
        .map((model) => model.id),
    ).toEqual(["goose-gpt-5-5", "goose-claude-opus-4"]);
  });

  it("clears a recorded error when the provider is invalidated", async () => {
    mocks.supportedModelsList
      .mockResolvedValueOnce({ models: [{ id: "goose-gpt-5-5" }] })
      .mockRejectedValueOnce(new Error("not authenticated"));
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });
    expect(
      useProviderModelCacheStore.getState().getError("databricks_v2"),
    ).toBe("not authenticated");

    useProviderModelCacheStore.getState().invalidateProvider("databricks_v2");

    // The failure described the credentials that were just replaced.
    expect(
      useProviderModelCacheStore.getState().getError("databricks_v2"),
    ).toBe(null);
  });

  it("drops the model list when the provider itself goes away", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [{ id: "goose-gpt-5-5" }],
    });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    useProviderModelCacheStore
      .getState()
      .invalidateProvider("databricks_v2", { forget: true });

    expect(
      useProviderModelCacheStore.getState().providers.has("databricks_v2"),
    ).toBe(false);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("databricks_v2"),
    ).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "[]")).toEqual(
      [],
    );
  });

  it("stops re-probing a failing provider on every picker open", async () => {
    mocks.supportedModelsList
      .mockRejectedValueOnce(new Error("bridge is not running"))
      .mockResolvedValue({ models: [{ id: "gpt-5-codex" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");
    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1);

    // Opening the picker lands here. An entry carrying an error is stale on
    // every read, and each probe of an ACP provider starts a new bridge child
    // process on the goose side.
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");
    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1);

    // Asking for it explicitly is not throttled.
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp", { force: true });

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("codex-acp")
        .map((model) => model.id),
    ).toEqual(["gpt-5-codex"]);
  });

  it("re-probes a failing provider straight after signing in again", async () => {
    mocks.supportedModelsList
      .mockRejectedValueOnce(new Error("not signed in"))
      .mockResolvedValueOnce({ models: [{ id: "gpt-5-codex" }] });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");
    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1);

    // The sign-in is exactly the news the retry floor was waiting for.
    useProviderModelCacheStore.getState().invalidateProvider("codex-acp");
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("codex-acp")
        .map((model) => model.id),
    ).toEqual(["gpt-5-codex"]);
  });

  // A harness that files none of its models: the rows are named and ordered
  // from what they say about themselves, which is all a host answered before
  // it stated a menu.
  it("names and orders Claude Code rows by the model each one resolves to", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [
        {
          id: "default",
          name: "Default (recommended)",
          description: "Opus 5 with 1M context · Best for everyday tasks",
        },
        {
          id: "opus[1m]",
          name: "Opus (1M context)",
          description: "Opus 5 with 1M context",
        },
        {
          id: "claude-fable-5[1m]",
          name: "Fable",
          description: "Fable 5 · Most capable",
        },
        { id: "sonnet", name: "Sonnet", description: "Sonnet 5 · Efficient" },
        { id: "haiku", name: "Haiku", description: "Haiku 4.5 · Fastest" },
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("claude-acp");

    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("claude-acp");
    expect(models.map((model) => [model.id, model.displayName])).toEqual([
      ["default", "Opus 5"],
      ["opus[1m]", "Opus 5"],
      ["claude-fable-5[1m]", "Fable 5"],
      ["sonnet", "Sonnet 5"],
      ["haiku", "Haiku 4.5"],
    ]);
    expect(
      [...models]
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
        .map((model) => model.id),
    ).toEqual(["claude-fable-5[1m]", "default", "opus[1m]", "sonnet", "haiku"]);
  });

  it("maps the menu the host files, row for row", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      providerId: "claude-acp",
      schemaVersion: CACHE_SCHEMA_VERSION,
      revision: "3:2026-09-13T20:03:09Z",
      models: [
        hostRow("claude-fable-5-1[1m]", {
          name: "Fable 5.1",
          description: "Fable 5.1 with 1M context",
          order: 10,
          opensOnModel: true,
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: false,
          capabilitySource: "declared",
        }),
        hostRow("opus[1m]", {
          name: "Opus 5",
          order: 20,
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: true,
          capabilitySource: "probed",
        }),
        hostRow("default", {
          name: "Default",
          description: "Opus 5 with 1M context · Best for everyday tasks",
          order: 20,
          aliasOf: "opus[1m]",
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: true,
          capabilitySource: "probed",
        }),
        hostRow("sonnet", {
          name: "Sonnet 5",
          order: 30,
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: true,
          capabilitySource: "probed",
        }),
        hostRow("haiku", {
          name: "Haiku 4.5",
          order: 40,
          supportsFast: false,
          capabilitySource: "probed",
        }),
        hostRow("claude-fable-5[1m]", {
          name: "Fable 5",
          group: "more",
          order: 50,
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: false,
          capabilitySource: "probed",
        }),
        hostRow("claude-opus-4-8", {
          name: "Opus 4.8",
          description: "Opus 4.8",
          group: "more",
          order: 60,
          opensOnModel: true,
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: true,
          capabilitySource: "declared",
        }),
        hostRow("claude-opus-4-7", {
          name: "Opus 4.7",
          description: "Opus 4.7",
          group: "more",
          order: 70,
          opensOnModel: true,
          efforts: efforts(CLAUDE_EFFORTS),
          supportsFast: true,
          capabilitySource: "declared",
        }),
        hostRow("claude-opus-4-6", {
          name: "Opus 4.6",
          description: "Opus 4.6",
          group: "more",
          order: 80,
          opensOnModel: true,
          efforts: efforts(CLAUDE_EFFORTS_NO_XHIGH),
          supportsFast: false,
          capabilitySource: "declared",
        }),
        hostRow("claude-sonnet-4-6", {
          name: "Sonnet 4.6",
          description: "Sonnet 4.6",
          group: "more",
          order: 90,
          opensOnModel: true,
          efforts: efforts(CLAUDE_EFFORTS_NO_XHIGH),
          supportsFast: false,
          capabilitySource: "declared",
        }),
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("claude-acp");

    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("claude-acp");
    expect(
      models.map((model) => [
        model.id,
        model.displayName,
        model.group,
        model.order,
        model.sortOrder,
      ]),
    ).toEqual([
      ["claude-fable-5-1[1m]", "Fable 5.1", "main", 10, 10],
      ["opus[1m]", "Opus 5", "main", 20, 20],
      // The alias is still labelled by the model it resolves to.
      ["default", "Opus 5", "main", 20, 20],
      ["sonnet", "Sonnet 5", "main", 30, 30],
      ["haiku", "Haiku 4.5", "main", 40, 40],
      ["claude-fable-5[1m]", "Fable 5", "more", 50, 50],
      ["claude-opus-4-8", "Opus 4.8", "more", 60, 60],
      ["claude-opus-4-7", "Opus 4.7", "more", 70, 70],
      ["claude-opus-4-6", "Opus 4.6", "more", 80, 80],
      ["claude-sonnet-4-6", "Sonnet 4.6", "more", 90, 90],
    ]);

    const row = (id: string) => models.find((model) => model.id === id);
    // The 4.6 pair has no xhigh, and the effort menu arrives in the shape a
    // live session advertises one.
    expect(row("claude-opus-4-6")).toEqual(
      expect.objectContaining({
        capabilitySource: "declared",
        opensOnModel: true,
        supportsFast: false,
        efforts: [
          { id: "default", name: "Default" },
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
          { id: "max", name: "Max" },
        ],
      }),
    );
    // Haiku has no effort control at all: an answered empty list, not an
    // unasked one.
    expect(row("haiku")?.efforts).toEqual([]);
    expect(row("haiku")?.capabilitySource).toBe("probed");
    expect(row("default")?.aliasOf).toBe("opus[1m]");
    expect(row("opus[1m]")?.aliasOf).toBeUndefined();
    expect(row("opus[1m]")?.opensOnModel).toBe(false);
    // Kept: outside the picker list this flag still chooses a new chat's
    // model and tells an explicit selection from a defaulted one.
    expect(models.every((model) => model.recommended)).toBe(true);
  });

  it("maps codex rows as base ids carrying their own effort menus", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      providerId: "codex-acp",
      schemaVersion: CACHE_SCHEMA_VERSION,
      revision: "3:2026-09-13T20:03:09Z",
      models: [
        hostRow("gpt-6-astra", {
          name: "GPT-6-Astra",
          description: "Our most capable model for complex, demanding work.",
          order: 1000,
          efforts: efforts(["low", "medium", "high", "xhigh", "max", "ultra"]),
          supportsFast: true,
          capabilitySource: "probed",
        }),
        hostRow("gpt-5.6-luna", {
          name: "GPT-5.6-Luna",
          description: "Fast and affordable agentic coding model.",
          order: 1003,
          efforts: efforts(["low", "medium", "high", "xhigh", "max"]),
          supportsFast: true,
          capabilitySource: "probed",
        }),
        hostRow("gpt-5.3-codex-spark", {
          name: "GPT-5.3-Codex-Spark",
          description: "Ultra-fast coding model.",
          order: 1005,
          efforts: efforts(["low", "medium", "high", "xhigh"]),
          supportsFast: false,
          capabilitySource: "probed",
        }),
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");

    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("codex-acp");
    // The cutover: no row is a model folded together with an effort any more.
    expect(models.every((model) => !model.id.includes("["))).toBe(true);
    expect(models.map((model) => [model.id, model.displayName])).toEqual([
      ["gpt-6-astra", "GPT-6-Astra"],
      ["gpt-5.6-luna", "GPT-5.6-Luna"],
      ["gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
    ]);
    expect(
      models.map((model) => model.efforts?.map((effort) => effort.id)),
    ).toEqual([
      ["low", "medium", "high", "xhigh", "max", "ultra"],
      ["low", "medium", "high", "xhigh", "max"],
      ["low", "medium", "high", "xhigh"],
    ]);
    expect(models.map((model) => model.supportsFast)).toEqual([
      true,
      true,
      false,
    ]);
    // A gpt row has no Claude-family order of its own, so before the host
    // filed these they carried no order at all.
    expect(models.map((model) => model.sortOrder)).toEqual([1000, 1003, 1005]);
  });

  it("maps a row the host says nothing about", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [
        {
          id: "gpt-5-codex",
          name: "GPT-5-Codex",
          description: "Frontier coding model",
        },
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("codex-acp");

    const [model] = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("codex-acp");
    expect(model).toEqual(
      expect.objectContaining({
        id: "gpt-5-codex",
        displayName: "GPT-5-Codex",
        recommended: true,
        // Never hidden: a row nobody filed is shown on the page the picker
        // opens on.
        group: "main",
        capabilitySource: "unknown",
      }),
    );
    expect(model?.efforts).toBeUndefined();
    expect(model?.supportsFast).toBeUndefined();
    expect(model?.defaultEffort).toBeUndefined();
    expect(model?.aliasOf).toBeUndefined();
    expect(model?.order).toBeUndefined();
    expect(model?.sortOrder).toBeUndefined();
  });

  it("never lets an unasked row read as a model with no effort control", async () => {
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [
        hostRow("gpt-5.6-luna", { name: "GPT-5.6-Luna" }),
        hostRow("haiku", { name: "Haiku 4.5", capabilitySource: "probed" }),
      ],
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("claude-acp");

    const models = useProviderModelCacheStore
      .getState()
      .getModelsForProvider("claude-acp");
    // Both rows answer with an empty list on the wire; only one of them was
    // ever asked, and that is the only one that means "no effort control".
    expect(models[0]?.efforts).toBeUndefined();
    expect(models[0]?.capabilitySource).toBe("unknown");
    expect(models[1]?.efforts).toEqual([]);
    expect(models[1]?.capabilitySource).toBe("probed");
    // Unknown is never "no": a supportsFast the host left null is dropped
    // rather than stored as false.
    expect(models[0]?.supportsFast).toBeUndefined();
  });

  it("re-polls a cached list that is still fresh when the refresh is forced", async () => {
    // The five-row picker: the host had gained models, the renderer was
    // holding a persisted list that had not aged out yet, and every refresh
    // call site was unforced -- so the new rows could not arrive at all.
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          providerId: "claude-acp",
          models: [seededModel({ id: "opus[1m]", providerId: "claude-acp" })],
          fetchedAt: Date.now(),
          schemaVersion: CACHE_SCHEMA_VERSION,
          revision: "3:2026-09-13T20:03:09Z",
          outcome: "models",
        },
      ]),
    );
    useProviderModelCacheStore.getState().loadPersisted();
    mocks.supportedModelsList.mockResolvedValue({
      models: [{ id: "opus[1m]" }, { id: "claude-opus-4-6" }],
      schemaVersion: CACHE_SCHEMA_VERSION,
      revision: "3:2026-09-13T21:44:00Z",
    });

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("claude-acp");
    expect(mocks.supportedModelsList).not.toHaveBeenCalled();

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("claude-acp", { force: true });

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1);
    expect(
      useProviderModelCacheStore
        .getState()
        .getModelsForProvider("claude-acp")
        .map((model) => model.id),
    ).toEqual(["opus[1m]", "claude-opus-4-6"]);
    expect(
      useProviderModelCacheStore.getState().providers.get("claude-acp")
        ?.revision,
    ).toBe("3:2026-09-13T21:44:00Z");
  });

  it.each([
    {
      label: "written by a build that shaped rows differently",
      schemaVersion: 1,
    },
    { label: "in the pre-stamp v1 shape", schemaVersion: undefined },
    {
      label: "from before rows said what a model can do",
      schemaVersion: 2,
    },
  ])("discards a persisted entry $label", ({ schemaVersion }) => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify([
        {
          providerId: "claude-acp",
          models: [seededModel({ id: "opus[1m]", providerId: "claude-acp" })],
          // Inside the TTL: age is not what makes this entry unusable.
          fetchedAt: Date.now(),
          outcome: "models",
          ...(schemaVersion === undefined ? {} : { schemaVersion }),
        },
      ]),
    );

    useProviderModelCacheStore.getState().loadPersisted();

    expect(
      useProviderModelCacheStore.getState().providers.has("claude-acp"),
    ).toBe(false);
    expect(
      useProviderModelCacheStore.getState().getModelsForProvider("claude-acp"),
    ).toEqual([]);
    expect(
      useProviderModelCacheStore
        .getState()
        .isModelInventoryAuthoritative("claude-acp"),
    ).toBe(false);
  });

  it("rewrites an entry when the host answers with a new inventory revision", async () => {
    const invalidated: string[] = [];
    const unsubscribe = subscribeProviderModelInventoryInvalidated(
      (providerId) => {
        invalidated.push(providerId);
      },
    );
    mocks.supportedModelsList
      .mockResolvedValueOnce({
        models: [],
        schemaVersion: CACHE_SCHEMA_VERSION,
        revision: "3:2026-09-13T20:03:09Z",
      })
      .mockResolvedValueOnce({
        models: [],
        schemaVersion: CACHE_SCHEMA_VERSION,
        revision: "3:2026-09-13T21:44:00Z",
      })
      .mockResolvedValueOnce({
        models: [],
        schemaVersion: CACHE_SCHEMA_VERSION,
        revision: "3:2026-09-13T21:44:00Z",
      });

    const pollOnce = () =>
      useProviderModelCacheStore.getState().refreshProviderModels("amp-acp");

    await pollOnce();
    expect(
      useProviderModelCacheStore.getState().providers.get("amp-acp")?.revision,
    ).toBe("3:2026-09-13T20:03:09Z");
    expect(invalidated).toEqual([]);

    // Same non-answer, different generation: the entry must not be left
    // describing an inventory the host has already replaced.
    await pollOnce();
    expect(
      useProviderModelCacheStore.getState().providers.get("amp-acp")?.revision,
    ).toBe("3:2026-09-13T21:44:00Z");
    expect(invalidated).toEqual(["amp-acp"]);

    // ...and an unchanged generation still costs nothing downstream.
    await pollOnce();
    expect(invalidated).toEqual(["amp-acp"]);
    unsubscribe();
  });

  it("collapses a burst of picker opens into one probe per provider", async () => {
    mocks.supportedModelsList.mockResolvedValue({
      models: [{ id: "gpt-5.6-luna" }],
      schemaVersion: CACHE_SCHEMA_VERSION,
      revision: "3:2026-09-13T20:03:09Z",
    });
    const openPicker = () =>
      useProviderModelCacheStore
        .getState()
        .refreshAllModelProviders(["copilot-acp"], {
          force: true,
          minIntervalMs: PICKER_REFRESH_FLOOR_MS,
        });

    await openPicker();
    await openPicker();
    await openPicker();

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(1);

    // A caller that knows the situation changed does not wait out the floor.
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("copilot-acp", { force: true });

    expect(mocks.supportedModelsList).toHaveBeenCalledTimes(2);
  });

  it("stores ACP error data when supported model refresh fails", async () => {
    const error = new Error("Internal error") as Error & { data: string };
    error.name = "RequestError";
    error.data =
      "Failed to fetch provider supported models: Databricks token expired";
    mocks.supportedModelsList.mockRejectedValueOnce(error);

    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");

    expect(
      useProviderModelCacheStore.getState().getError("databricks_v2"),
    ).toBe(
      "Failed to fetch provider supported models: Databricks token expired",
    );
  });
});
