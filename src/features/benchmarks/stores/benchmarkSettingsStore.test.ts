import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isDesktopRuntime: vi.fn(() => true),
  readDistillDocument: vi.fn(async (_path: string) => null as string | null),
  writeDistillDocument: vi.fn(async (_path: string, _contents: string) => {}),
}));

vi.mock("@/shared/api/distillStore", () => ({
  isDesktopRuntime: mocks.isDesktopRuntime,
  readDistillDocument: mocks.readDistillDocument,
  writeDistillDocument: mocks.writeDistillDocument,
}));

import type { JudgePoolEntry } from "../types";
import {
  BENCHMARK_SETTINGS_DOCUMENT,
  DEFAULT_BENCHMARK_SETTINGS,
  DEFAULT_TIME_LIMIT_MINUTES,
  MAX_JUDGE_POOL_ENTRIES,
  flushBenchmarkSettings,
  hydrateBenchmarkSettingsStore,
  normalizeCreditLimit,
  parseBenchmarkSettings,
  serializeBenchmarkSettings,
  useBenchmarkSettingsStore,
} from "./benchmarkSettingsStore";

/** Entries as a read normalizes them: every field present. */
const alpha: JudgePoolEntry = {
  providerId: "codex-acp",
  modelId: "judge-alpha",
  effort: "high",
};
const gamma: JudgePoolEntry = {
  providerId: "grok-acp",
  modelId: "judge-gamma",
  effort: null,
  inputs: ["text"],
};

/** `count` distinct entries of one provider. */
function entries(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    providerId: "codex-acp",
    modelId: `judge-${i}`,
  }));
}

function pool(judgePool: unknown) {
  return parseBenchmarkSettings({ judgePool }).judgePool;
}

function dataUse(providerDataUse: unknown) {
  return parseBenchmarkSettings({ providerDataUse }).providerDataUse;
}

/** The last document written, parsed. */
function lastWrite(): unknown {
  const call = mocks.writeDistillDocument.mock.calls.at(-1);
  if (!call) throw new Error("Nothing was written");
  expect(call[0]).toBe(BENCHMARK_SETTINGS_DOCUMENT);
  return JSON.parse(call[1]);
}

beforeEach(async () => {
  // A write a test queued and left must not land in the next one.
  await flushBenchmarkSettings();
  vi.clearAllMocks();
  mocks.isDesktopRuntime.mockReturnValue(true);
  mocks.readDistillDocument.mockResolvedValue(null);
  mocks.writeDistillDocument.mockResolvedValue(undefined);
  useBenchmarkSettingsStore.setState({
    settings: { ...DEFAULT_BENCHMARK_SETTINGS },
    hydrated: false,
  });
});

describe("benchmark settings", () => {
  it("keeps credits off until a limit is stored", () => {
    expect(parseBenchmarkSettings({ timeLimitMinutes: 90 })).toEqual({
      timeLimitMinutes: 90,
      creditLimit: null,
      judgePool: [],
      providerDataUse: {},
    });
    expect(parseBenchmarkSettings(null)).toEqual({
      timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
      creditLimit: null,
      judgePool: [],
      providerDataUse: {},
    });
    for (const stored of ["500", -1, Number.NaN, null]) {
      expect(parseBenchmarkSettings({ creditLimit: stored }).creditLimit).toBe(
        null,
      );
    }
  });

  it("stores a limit as whole credits, zero included", () => {
    expect(parseBenchmarkSettings({ creditLimit: 499.6 }).creditLimit).toBe(
      500,
    );
    expect(normalizeCreditLimit(0)).toBe(0);
    expect(normalizeCreditLimit(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("benchmark judge pool", () => {
  it("starts empty and reads anything but a list as empty", () => {
    expect(DEFAULT_BENCHMARK_SETTINGS.judgePool).toEqual([]);
    for (const stored of [undefined, null, "codex-acp", { 0: alpha }, 3]) {
      expect(pool(stored)).toEqual([]);
    }
  });

  it("keeps valid entries, trimmed, and drops the rest", () => {
    const long = "x".repeat(257);
    const kept = pool([
      { providerId: " codex-acp ", modelId: " judge-alpha ", effort: "high" },
      null,
      "judge-alpha",
      ["codex-acp", "judge-alpha"],
      { providerId: "", modelId: "judge-empty" },
      { providerId: "codex-acp", modelId: "   " },
      { providerId: "codex-acp", modelId: long },
      { providerId: long, modelId: "judge-long" },
      { providerId: 7, modelId: "judge-seven" },
      { providerId: "codex-acp", modelId: "judge-blank", effort: "" },
      { providerId: "codex-acp", modelId: "judge-number", effort: 3 },
      {
        providerId: "codex-acp",
        modelId: "judge-wide",
        effort: "e".repeat(65),
      },
      { providerId: "codex-acp", modelId: "judge-audio", inputs: ["audio"] },
      { providerId: "codex-acp", modelId: "judge-word", inputs: "text" },
      { providerId: "grok-acp", modelId: "judge-gamma", inputs: ["text"] },
      {
        providerId: "kimi-acp",
        modelId: "judge-delta",
        effort: " medium ",
        inputs: ["visual", "text", "visual"],
      },
      { providerId: "zai-acp", modelId: "judge-epsilon", inputs: null },
      { providerId: "zai-acp", modelId: "judge-none", inputs: [] },
      {
        providerId: "codex-acp",
        modelId: "x".repeat(256),
        effort: "e".repeat(64),
      },
    ]);

    expect(kept).toEqual([
      alpha,
      gamma,
      {
        providerId: "kimi-acp",
        modelId: "judge-delta",
        effort: "medium",
        inputs: ["text", "visual"],
      },
      { providerId: "zai-acp", modelId: "judge-epsilon", effort: null },
      {
        providerId: "codex-acp",
        modelId: "x".repeat(256),
        effort: "e".repeat(64),
      },
    ]);
    // Absent and null inputs both mean text and visual: no key is kept.
    expect(kept[3]).not.toHaveProperty("inputs");
  });

  it("reads past the old per-entry data-use flag and never writes it", () => {
    // Whether a provider's models judge is its data use, not the entry's.
    const stored = [true, "true", false, null, undefined];
    const kept = pool(
      stored.map((disclosureConfirmed, i) => ({
        providerId: "codex-acp",
        modelId: `judge-${i}`,
        disclosureConfirmed,
      })),
    );

    expect(kept.map((entry) => entry.modelId)).toEqual([
      "judge-0",
      "judge-1",
      "judge-2",
      "judge-3",
      "judge-4",
    ]);
    for (const entry of kept) {
      expect(entry).not.toHaveProperty("disclosureConfirmed");
    }
    const written = serializeBenchmarkSettings(
      parseBenchmarkSettings({ judgePool: kept }),
    );
    for (const entry of written.judgePool) {
      expect(entry).not.toHaveProperty("disclosureConfirmed");
    }
  });

  it("keeps the accounts an entry may sit on and drops a malformed list", () => {
    const kept = pool([
      { providerId: "claude-acp", modelId: "sonnet", accounts: ["acct-b"] },
      { providerId: "claude-acp", modelId: "haiku", accounts: [] },
      { providerId: "claude-acp", modelId: "opus", accounts: [" padded"] },
      { providerId: "claude-acp", modelId: "fable", accounts: "acct-b" },
      { providerId: "codex-acp", modelId: "sol" },
    ]);

    expect(kept.map((entry) => entry.modelId)).toEqual(["sonnet", "sol"]);
    expect(kept[0].accounts).toEqual(["acct-b"]);
    expect(kept[1]).not.toHaveProperty("accounts");
    const written = serializeBenchmarkSettings(
      parseBenchmarkSettings({ judgePool: kept }),
    );
    expect(written.judgePool[0].accounts).toEqual(["acct-b"]);
  });

  it("keeps the first of entries with the same model and effort", () => {
    const beta = { providerId: "codex-acp", modelId: "judge-beta" };
    const other = { ...alpha, providerId: "claude-acp" };
    const kept = pool([
      alpha,
      { ...alpha, inputs: ["visual"] },
      { ...alpha, disclosureConfirmed: true },
      { ...alpha, effort: "medium" },
      beta,
      { ...beta, effort: null, inputs: ["text"] },
      other,
    ]);

    expect(kept).toEqual([
      alpha,
      { ...alpha, effort: "medium" },
      { ...beta, effort: null },
      other,
    ]);
  });

  it("keeps at most the pool's limit of entries", () => {
    const kept = pool([
      { providerId: "" },
      ...entries(MAX_JUDGE_POOL_ENTRIES + 5),
    ]);

    expect(kept).toHaveLength(MAX_JUDGE_POOL_ENTRIES);
    expect(kept[0].modelId).toBe("judge-0");
    expect(kept.at(-1)?.modelId).toBe(`judge-${MAX_JUDGE_POOL_ENTRIES - 1}`);
  });

  it("writes the pool back exactly as it reads it", () => {
    const epsilon = { providerId: "zai-acp", modelId: "judge-epsilon" };
    const settings = parseBenchmarkSettings({
      timeLimitMinutes: 75,
      creditLimit: 40,
      judgePool: [alpha, gamma, epsilon],
    });
    const written = JSON.parse(
      JSON.stringify(serializeBenchmarkSettings(settings)),
    );

    expect(written).toEqual({
      timeLimitMinutes: 75,
      creditLimit: 40,
      judgePool: [alpha, gamma, { ...epsilon, effort: null }],
      providerDataUse: {},
    });
    expect(parseBenchmarkSettings(written)).toEqual(settings);
  });

  it("keeps the pool when the time limit or credits are written", async () => {
    mocks.readDistillDocument.mockResolvedValue(
      JSON.stringify({
        timeLimitMinutes: 240,
        creditLimit: null,
        judgePool: [alpha, gamma],
      }),
    );
    await hydrateBenchmarkSettingsStore();

    useBenchmarkSettingsStore.getState().setTimeLimitMinutes(90);
    await flushBenchmarkSettings();

    expect(lastWrite()).toEqual({
      timeLimitMinutes: 90,
      creditLimit: null,
      judgePool: [alpha, gamma],
      providerDataUse: {},
    });

    useBenchmarkSettingsStore.getState().setCreditLimit(12);
    await flushBenchmarkSettings();

    expect(lastWrite()).toEqual({
      timeLimitMinutes: 90,
      creditLimit: 12,
      judgePool: [alpha, gamma],
      providerDataUse: {},
    });
  });

  it("adds and removes entries and writes the whole document", async () => {
    await hydrateBenchmarkSettingsStore();
    const store = useBenchmarkSettingsStore.getState();
    const settings = () => useBenchmarkSettingsStore.getState().settings;

    expect(store.addJudgePoolEntry(alpha)).toBe(true);
    expect(store.addJudgePoolEntry({ ...alpha, inputs: ["text"] })).toBe(false);
    expect(store.addJudgePoolEntry({ providerId: " ", modelId: "x" })).toBe(
      false,
    );
    expect(store.addJudgePoolEntry(gamma)).toBe(true);
    await flushBenchmarkSettings();

    expect(settings().judgePool).toEqual([alpha, gamma]);
    expect(lastWrite()).toEqual({
      timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
      creditLimit: null,
      judgePool: [alpha, gamma],
      providerDataUse: {},
    });

    store.removeJudgePoolEntry({ ...alpha, effort: "medium" });
    expect(settings().judgePool).toEqual([alpha, gamma]);

    store.removeJudgePoolEntry({ ...alpha, inputs: ["visual"] });
    await flushBenchmarkSettings();

    expect(settings().judgePool).toEqual([gamma]);
    expect(lastWrite()).toMatchObject({ judgePool: [gamma] });

    store.setJudgePool([gamma, gamma, alpha, { providerId: "", modelId: "" }]);
    expect(settings().judgePool).toEqual([gamma, alpha]);
  });

  it("refuses an entry once the pool is full", () => {
    const store = useBenchmarkSettingsStore.getState();
    store.setJudgePool(entries(MAX_JUDGE_POOL_ENTRIES));

    expect(store.addJudgePoolEntry(alpha)).toBe(false);
    expect(
      useBenchmarkSettingsStore.getState().settings.judgePool,
    ).toHaveLength(MAX_JUDGE_POOL_ENTRIES);
  });

  it("writes nothing before the stored document has been read", async () => {
    const store = useBenchmarkSettingsStore.getState();
    store.addJudgePoolEntry(alpha);
    store.setTimeLimitMinutes(30);
    store.setProviderTrainsOnSubmissions("zai-acp", false);
    await flushBenchmarkSettings();

    expect(useBenchmarkSettingsStore.getState().settings).toEqual({
      timeLimitMinutes: 30,
      creditLimit: null,
      judgePool: [alpha],
      providerDataUse: { "zai-acp": { trainsOnSubmissions: false } },
    });
    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();
  });
});

describe("benchmark provider data use", () => {
  it("starts with no word on any provider and reads anything but an object as none", () => {
    expect(DEFAULT_BENCHMARK_SETTINGS.providerDataUse).toEqual({});
    for (const stored of [
      undefined,
      null,
      "zai-acp",
      3,
      true,
      [{ trainsOnSubmissions: true }],
    ]) {
      expect(dataUse(stored)).toEqual({});
    }
  });

  it("keeps each provider's boolean word, trimmed, and drops the rest", () => {
    const long = "p".repeat(129);
    const kept = dataUse({
      " zai-acp ": { trainsOnSubmissions: false },
      "kimi-acp": { trainsOnSubmissions: true, note: "kept out" },
      "grok-acp": { trainsOnSubmissions: "yes" },
      "codex-acp": { trainsOnSubmissions: null },
      "claude-acp": {},
      "invented-a": true,
      "invented-b": [{ trainsOnSubmissions: true }],
      "invented-c": null,
      "   ": { trainsOnSubmissions: true },
      "": { trainsOnSubmissions: true },
      [long]: { trainsOnSubmissions: true },
      ["q".repeat(128)]: { trainsOnSubmissions: true },
      // Equal once trimmed: the first one counts.
      "zai-acp": { trainsOnSubmissions: true },
    });

    expect(kept).toEqual({
      "zai-acp": { trainsOnSubmissions: false },
      "kimi-acp": { trainsOnSubmissions: true },
      ["q".repeat(128)]: { trainsOnSubmissions: true },
    });
  });

  it("keeps an id like __proto__ as an ordinary key", () => {
    const kept = dataUse(
      JSON.parse('{"__proto__": {"trainsOnSubmissions": true}}'),
    );

    expect(Object.keys(kept)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
  });

  it("writes the word back exactly as it reads it", () => {
    const settings = parseBenchmarkSettings({
      providerDataUse: {
        "zai-acp": { trainsOnSubmissions: false },
        "grok-acp": { trainsOnSubmissions: true, extra: 1 },
        "kimi-acp": { trainsOnSubmissions: "no" },
      },
    });
    const written = JSON.parse(
      JSON.stringify(serializeBenchmarkSettings(settings)),
    );

    expect(written.providerDataUse).toEqual({
      "zai-acp": { trainsOnSubmissions: false },
      "grok-acp": { trainsOnSubmissions: true },
    });
    expect(parseBenchmarkSettings(written)).toEqual(settings);
  });

  it("keeps the word when the time limit or the pool is written", async () => {
    mocks.readDistillDocument.mockResolvedValue(
      JSON.stringify({
        timeLimitMinutes: 240,
        creditLimit: null,
        judgePool: [alpha],
        providerDataUse: {
          "zai-acp": { trainsOnSubmissions: false },
          "codex-acp": { trainsOnSubmissions: true },
          "kimi-acp": { trainsOnSubmissions: "maybe" },
        },
      }),
    );
    await hydrateBenchmarkSettingsStore();
    const stated = {
      "zai-acp": { trainsOnSubmissions: false },
      "codex-acp": { trainsOnSubmissions: true },
    };

    useBenchmarkSettingsStore.getState().setTimeLimitMinutes(45);
    await flushBenchmarkSettings();

    expect(lastWrite()).toEqual({
      timeLimitMinutes: 45,
      creditLimit: null,
      judgePool: [alpha],
      providerDataUse: stated,
    });

    useBenchmarkSettingsStore.getState().addJudgePoolEntry(gamma);
    await flushBenchmarkSettings();

    expect(lastWrite()).toMatchObject({
      judgePool: [alpha, gamma],
      providerDataUse: stated,
    });
  });

  it("sets and clears one provider's word and writes the whole document", async () => {
    await hydrateBenchmarkSettingsStore();
    const store = useBenchmarkSettingsStore.getState();
    const stated = () =>
      useBenchmarkSettingsStore.getState().settings.providerDataUse;

    store.setProviderTrainsOnSubmissions(" zai-acp ", false);
    store.setProviderTrainsOnSubmissions("grok-acp", true);
    await flushBenchmarkSettings();

    expect(stated()).toEqual({
      "zai-acp": { trainsOnSubmissions: false },
      "grok-acp": { trainsOnSubmissions: true },
    });
    expect(lastWrite()).toEqual({
      timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
      creditLimit: null,
      judgePool: [],
      providerDataUse: {
        "zai-acp": { trainsOnSubmissions: false },
        "grok-acp": { trainsOnSubmissions: true },
      },
    });

    // A change of mind keeps the provider in its place.
    store.setProviderTrainsOnSubmissions("zai-acp", true);
    expect(Object.entries(stated())).toEqual([
      ["zai-acp", { trainsOnSubmissions: true }],
      ["grok-acp", { trainsOnSubmissions: true }],
    ]);

    // Back to the default: the provider is no longer named at all.
    store.clearProviderDataUse("grok-acp");
    await flushBenchmarkSettings();

    expect(stated()).toEqual({ "zai-acp": { trainsOnSubmissions: true } });
    expect(lastWrite()).toMatchObject({
      providerDataUse: { "zai-acp": { trainsOnSubmissions: true } },
    });
    expect(
      (lastWrite() as { providerDataUse: object }).providerDataUse,
    ).not.toHaveProperty("grok-acp");

    // Ids the document would not keep change nothing.
    const writes = mocks.writeDistillDocument.mock.calls.length;
    store.setProviderTrainsOnSubmissions("  ", true);
    store.setProviderTrainsOnSubmissions("p".repeat(129), true);
    store.clearProviderDataUse("kimi-acp");
    await flushBenchmarkSettings();

    expect(stated()).toEqual({ "zai-acp": { trainsOnSubmissions: true } });
    expect(mocks.writeDistillDocument).toHaveBeenCalledTimes(writes);
  });
});
