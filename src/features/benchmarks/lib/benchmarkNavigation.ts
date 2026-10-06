export const BENCHMARK_SECTIONS = [
  "leaderboard",
  "design",
  "development",
] as const;
export type BenchmarkSection = (typeof BENCHMARK_SECTIONS)[number];
export interface BenchmarkLocation {
  section: BenchmarkSection;
  /** A leaderboard row opened as its own page, by row key. */
  configurationId?: string;
  benchmarkId?: string;
  runId?: string;
  attemptId?: string;
}
