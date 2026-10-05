/**
 * Benchmark settings: edited in Settings, persisted as a document in the
 * Distill folder beside the benchmark database.
 *
 * Like every document store here, it starts on the defaults and refuses to
 * write until its read has landed, so a default written during startup never
 * replaces the operator's value.
 */

import { create } from "zustand";

import { distillDocument } from "@/shared/lib/distillDocument";

export const BENCHMARK_SETTINGS_DOCUMENT = "benchmarks/settings.json";

/**
 * How long one test may run, in minutes. It only stops a test that never
 * finishes: a model on its highest effort may work an hour or two on one
 * case, and speed is measured on its own board.
 */
export const DEFAULT_TIME_LIMIT_MINUTES = 4 * 60;

/** `benchmarks::MAX_TIME_LIMIT_SECONDS`, in minutes. */
export const MAX_TIME_LIMIT_MINUTES = 24 * 60;

export interface BenchmarkSettings {
  timeLimitMinutes: number;
}

export function clampTimeLimitMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_TIME_LIMIT_MINUTES;
  return Math.min(MAX_TIME_LIMIT_MINUTES, Math.max(1, Math.round(minutes)));
}

export function parseBenchmarkSettings(raw: unknown): BenchmarkSettings {
  const value =
    raw && typeof raw === "object"
      ? (raw as { timeLimitMinutes?: unknown }).timeLimitMinutes
      : undefined;
  return {
    timeLimitMinutes:
      typeof value === "number"
        ? clampTimeLimitMinutes(value)
        : DEFAULT_TIME_LIMIT_MINUTES,
  };
}

const document = distillDocument<BenchmarkSettings>({
  path: BENCHMARK_SETTINGS_DOCUMENT,
  legacyStorageKey: "distill:benchmark-settings",
  parse: parseBenchmarkSettings,
  serialize: (settings) => settings,
});

interface BenchmarkSettingsState {
  settings: BenchmarkSettings;
  /** False until the stored document has been read. Writes wait for it. */
  hydrated: boolean;
  setTimeLimitMinutes: (minutes: number) => void;
}

export const useBenchmarkSettingsStore = create<BenchmarkSettingsState>(
  (set, get) => ({
    settings: { timeLimitMinutes: DEFAULT_TIME_LIMIT_MINUTES },
    hydrated: false,
    setTimeLimitMinutes: (minutes) => {
      const settings = {
        ...get().settings,
        timeLimitMinutes: clampTimeLimitMinutes(minutes),
      };
      set({ settings });
      if (get().hydrated) document.write(settings);
    },
  }),
);

export async function hydrateBenchmarkSettingsStore(): Promise<void> {
  const stored = await document.read();
  useBenchmarkSettingsStore.setState((state) => ({
    settings: stored ?? state.settings,
    hydrated: true,
  }));
}

/**
 * The time limit a new run gives each of `versions`, in seconds: the setting,
 * and never less than the least time a chosen case asks a run to allow.
 */
export function runTimeLimitSeconds(
  versions: readonly { manifest: { limits: { timeoutSeconds: number } } }[],
): number {
  return Math.max(
    useBenchmarkSettingsStore.getState().settings.timeLimitMinutes * 60,
    ...versions.map((version) => version.manifest.limits.timeoutSeconds),
  );
}
