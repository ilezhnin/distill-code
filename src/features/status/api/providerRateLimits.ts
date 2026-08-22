import { invoke } from "@tauri-apps/api/core";
import type { ProviderRateLimitSnapshot } from "../lib/rateLimitTypes";

export async function getProviderRateLimits(): Promise<ProviderRateLimitSnapshot> {
  if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
    return { providers: [], updatedAt: Date.now() };
  }
  return invoke<ProviderRateLimitSnapshot>("get_provider_rate_limits");
}
