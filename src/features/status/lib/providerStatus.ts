import type { AgentProviderReadiness } from "@/features/providers/hooks/useAgentProviderStatus";
import type { ProviderCatalogEntry } from "@/shared/types/providers";
import type { ProviderRateLimits } from "./rateLimitTypes";

/** Every catalog provider has a status, even without a quota API adapter. */
export function buildProviderStatuses(
  catalog: readonly ProviderCatalogEntry[],
  usage: readonly ProviderRateLimits[] | undefined,
  readiness: ReadonlyMap<string, AgentProviderReadiness>,
): ProviderRateLimits[] {
  const byId = new Map(usage?.map((provider) => [provider.provider, provider]));
  return catalog.map(({ id }) => {
    const metrics = byId.get(id);
    const state = readiness.get(id);
    if (metrics && state !== "not_ready") return metrics;
    return {
      provider: id,
      session: null,
      weekly: null,
      updatedAt: 0,
      error: state === "not_ready" ? (metrics?.error ?? null) : null,
      status: state ? "unavailable" : "idle",
      configured: state === "ready",
    };
  });
}
