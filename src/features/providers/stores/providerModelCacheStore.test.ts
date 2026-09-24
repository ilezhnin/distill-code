import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelOption } from "@/features/chat/types";
import type { ProviderInventoryModel } from "@/shared/api/hostTypes";
import {
  isCachedModelInventoryAuthoritative,
  isCachedModelInventoryAuthoritativeForRouting,
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

  it("stops calling a provider authoritative for routing once its poll fails", async () => {
    // The picker may keep showing the last known list — that is why the entry
    // survives a failed refresh — but nothing may be *started* on it: a bridge
    // whose poll just failed is the one case where yesterday's list is a lie,
    // and the crew ranking has no other signal for "is this harness usable".
    mocks.supportedModelsList.mockResolvedValueOnce({
      models: [{ id: "goose-gpt-5-6-sol" }],
    });
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2");
    const fetched = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(isCachedModelInventoryAuthoritative(fetched)).toBe(true);
    expect(isCachedModelInventoryAuthoritativeForRouting(fetched)).toBe(true);

    mocks.supportedModelsList.mockRejectedValueOnce(
      new Error("bridge not installed"),
    );
    await useProviderModelCacheStore
      .getState()
      .refreshProviderModels("databricks_v2", { force: true });

    const failed = useProviderModelCacheStore
      .getState()
      .providers.get("databricks_v2");
    expect(failed?.models.map((model) => model.id)).toEqual([
      "goose-gpt-5-6-sol",
    ]);
    // Still authoritative for display, no longer for routing.
    expect(isCachedModelInventoryAuthoritative(failed)).toBe(true);
    expect(isCachedModelInventoryAuthoritativeForRouting(failed)).toBe(false);
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
});
