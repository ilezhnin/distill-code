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
  disclosureConfirmed: true,
};
const gamma: JudgePoolEntry = {
  providerId: "grok-acp",
  modelId: "judge-gamma",
  effort: null,
  inputs: ["text"],
  disclosureConfirmed: false,
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
    });
    expect(parseBenchmarkSettings(null)).toEqual({
      timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES,
      creditLimit: null,
      judgePool: [],
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
      {
        providerId: " codex-acp ",
        modelId: " judge-alpha ",
        effort: "high",
        disclosureConfirmed: true,
      },
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
        disclosureConfirmed: false,
      },
      {
        providerId: "zai-acp",
        modelId: "judge-epsilon",
        effort: null,
        disclosureConfirmed: false,
      },
      {
        providerId: "codex-acp",
        modelId: "x".repeat(256),
        effort: "e".repeat(64),
        disclosureConfirmed: false,
      },
    ]);
    // Absent and null inputs both mean text and visual: no key is kept.
    expect(kept[3]).not.toHaveProperty("inputs");
  });

  it("confirms data use only on an explicit true", () => {
    const stored = [true, "true", 1, null, undefined, {}];
    const kept = pool(
      stored.map((disclosureConfirmed, i) => ({
        providerId: "codex-acp",
        modelId: `judge-${i}`,
        disclosureConfirmed,
      })),
    );

    expect(kept.map((entry) => entry.disclosureConfirmed)).toEqual([
      true,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("keeps the first of entries with the same model and effort", () => {
    const beta = { providerId: "codex-acp", modelId: "judge-beta" };
    const other = { ...alpha, providerId: "claude-acp" };
    const kept = pool([
      alpha,
      { ...alpha, inputs: ["visual"] },
      { ...alpha, disclosureConfirmed: false },
      { ...alpha, effort: "medium" },
      beta,
      { ...beta, effort: null, disclosureConfirmed: true },
      other,
    ]);

    expect(kept).toEqual([
      alpha,
      { ...alpha, effort: "medium" },
      { ...beta, effort: null, disclosureConfirmed: false },
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

    // The confirmation is written even when off, so the backend never has
    // to guess what a missing one means.
    expect(written).toEqual({
      timeLimitMinutes: 75,
      creditLimit: 40,
      judgePool: [
        alpha,
        gamma,
        { ...epsilon, effort: null, disclosureConfirmed: false },
      ],
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
    });

    useBenchmarkSettingsStore.getState().setCreditLimit(12);
    await flushBenchmarkSettings();

    expect(lastWrite()).toEqual({
      timeLimitMinutes: 90,
      creditLimit: 12,
      judgePool: [alpha, gamma],
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

  it("records the data-use confirmation of one entry", async () => {
    await hydrateBenchmarkSettingsStore();
    const store = useBenchmarkSettingsStore.getState();
    const settings = () => useBenchmarkSettingsStore.getState().settings;
    store.setJudgePool([alpha, gamma]);

    store.setJudgeDisclosureConfirmed({ ...gamma, inputs: null }, true);
    store.setJudgeDisclosureConfirmed(alpha, false);
    await flushBenchmarkSettings();

    const confirmed = { ...gamma, disclosureConfirmed: true };
    const unconfirmed = { ...alpha, disclosureConfirmed: false };
    expect(settings().judgePool).toEqual([unconfirmed, confirmed]);
    expect(lastWrite()).toMatchObject({ judgePool: [unconfirmed, confirmed] });

    store.setJudgeDisclosureConfirmed({ ...alpha, effort: "low" }, true);
    expect(settings().judgePool).toEqual([unconfirmed, confirmed]);
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
    await flushBenchmarkSettings();

    expect(useBenchmarkSettingsStore.getState().settings).toEqual({
      timeLimitMinutes: 30,
      creditLimit: null,
      judgePool: [alpha],
    });
    expect(mocks.writeDistillDocument).not.toHaveBeenCalled();
  });
});
