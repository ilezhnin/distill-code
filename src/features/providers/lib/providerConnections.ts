import { CURATED_PROVIDER_CATALOG } from "@/features/providers/curatedProviders";
import { getPreferenceStorage } from "@/shared/preferences/rootSettings";
import {
  MANAGED_ACCOUNT_PROVIDERS,
  type ProviderAccount,
} from "../api/providerAccounts";

const STORAGE_KEY = "distill:providerConnections:v1";

interface ProviderConnections {
  /** When each provider last became ready, in epoch milliseconds. */
  connectedAt: Record<string, number>;
  /** The providers that were ready when readiness was last noted. */
  ready: string[];
}

function readConnections(): ProviderConnections {
  try {
    const raw = getPreferenceStorage()?.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ProviderConnections>) : {};
    return {
      connectedAt:
        parsed.connectedAt && typeof parsed.connectedAt === "object"
          ? parsed.connectedAt
          : {},
      ready: Array.isArray(parsed.ready) ? parsed.ready : [],
    };
  } catch {
    return { connectedAt: {}, ready: [] };
  }
}

function writeConnections(connections: ProviderConnections): void {
  try {
    getPreferenceStorage()?.setItem(STORAGE_KEY, JSON.stringify(connections));
  } catch {
    // localStorage may be unavailable.
  }
}

/**
 * Notes which providers are ready now. A provider that was not ready the last
 * time (never connected here, or signed out since) counts as connected now.
 */
export function recordReadyProviders(
  readyIds: ReadonlySet<string>,
  now = Date.now(),
): void {
  const connections = readConnections();
  const wasReady = new Set(connections.ready);
  let changed = wasReady.size !== readyIds.size;
  for (const id of readyIds) {
    if (!wasReady.has(id)) {
      connections.connectedAt[id] = now;
      changed = true;
    }
  }
  if (changed) {
    writeConnections({
      connectedAt: connections.connectedAt,
      ready: [...readyIds],
    });
  }
}

/**
 * Whether a sign-in to this provider has completed here: the provider was
 * ready at least once and, where Distill keeps the provider's accounts, an
 * account is still saved. A not-ready provider with one is a real account
 * that signed out or expired. Without one it is a setup that only installed
 * the CLI or saved an account before its browser sign-in was abandoned.
 */
export function hasCompletedSignIn(
  providerId: string,
  accounts: readonly ProviderAccount[],
): boolean {
  if (
    (MANAGED_ACCOUNT_PROVIDERS as readonly string[]).includes(providerId) &&
    !accounts.some((account) => account.providerId === providerId)
  ) {
    return false;
  }
  return Object.hasOwn(readConnections().connectedAt, providerId);
}

function catalogRank(providerId: string): number {
  const index = CURATED_PROVIDER_CATALOG.findIndex(
    (entry) => entry.id === providerId,
  );
  return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

/**
 * The ready provider whose account was connected most recently — where a new
 * chat starts when no provider was ever chosen. A ready provider not yet noted
 * is the newest of all, unless nothing has been noted yet: then every ready
 * provider ties, as do providers first noted together. `fallback` wins a tie
 * it is part of; otherwise the catalog order decides.
 */
export function mostRecentlyConnectedProvider(
  readyIds: ReadonlySet<string>,
  fallback: string,
): string {
  if (readyIds.size === 0) {
    return fallback;
  }
  const { connectedAt, ready } = readConnections();
  const noted = new Set(ready);
  const timeOf = (id: string) => {
    if (noted.size > 0 && !noted.has(id)) return Number.POSITIVE_INFINITY;
    return connectedAt[id] ?? Number.NEGATIVE_INFINITY;
  };
  const latest = Math.max(...[...readyIds].map(timeOf));
  const newest = [...readyIds].filter((id) => timeOf(id) === latest);
  if (newest.includes(fallback)) {
    return fallback;
  }
  return newest.sort(
    (left, right) => catalogRank(left) - catalogRank(right),
  )[0];
}
