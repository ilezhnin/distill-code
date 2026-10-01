export const BENCHMARK_SECTIONS = [
  "leaderboard",
  "development",
  "nerf",
  "usage",
] as const;
export type BenchmarkSection = (typeof BENCHMARK_SECTIONS)[number];
export interface BenchmarkLocation {
  section: BenchmarkSection;
  benchmarkId?: string;
  runId?: string;
  attemptId?: string;
}
