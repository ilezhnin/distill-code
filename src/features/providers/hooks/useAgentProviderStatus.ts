import { useCallback, useEffect, useMemo } from "react";
import type { DoctorCheck, DoctorReport } from "@/shared/api/doctor";
import { useDoctorReport } from "@/shared/api/useDoctorReport";
import { crateCheckIdToProviderId } from "@/features/providers/lib/agentIdMap";
import { recordReadyProviders } from "@/features/providers/lib/providerConnections";
import { getCatalogEntry } from "@/features/providers/providerCatalog";
import { useProviderAccountsStore } from "../stores/providerAccountsStore";
import { accountIsConnected } from "../lib/providerAccountStatus";
import type {
  ProviderAccountModel,
  ProviderAccountStatus,
} from "../api/providerAccounts";

export type AgentProviderReadiness = "ready" | "not_installed" | "not_ready";

interface UseAgentProviderStatusReturn {
  readyAgentIds: Set<string>;
  agentReadiness: Map<string, AgentProviderReadiness>;
  // The raw doctor check per provider id, so callers can surface install
  // source / version / update-available without re-probing.
  agentChecks: Map<string, DoctorCheck>;
  loading: boolean;
  /** True when the doctor report failed: readiness is unknown, not "missing". */
  statusUnavailable: boolean;
  refresh: () => Promise<Map<string, AgentProviderReadiness>>;
}

// Derive per-agent readiness from the doctor report. The crate identifies
// agents by `ai-agent-<name>`; map those back to the frontend's provider ids
// before recording readiness. Exported for non-hook consumers (flockctl)
// that share the agent picker's readiness semantics.
export function readinessFromReport(
  report: DoctorReport,
): Map<string, AgentProviderReadiness> {
  const readiness = new Map<string, AgentProviderReadiness>();
  for (const check of report.checks) {
    const providerId = crateCheckIdToProviderId(check.id);
    if (!providerId) continue;

    const provider = getCatalogEntry(providerId);

    // A two-binary ACP agent (e.g. Amp) whose main CLI is present but whose
    // ACP bridge binary is missing: the doctor crate flags it status="warn"
    // with fixType="bridge", leaves bridge/bridgePath null, and keeps `path`
    // pointed at the main CLI. The bridge is what makes the agent usable over
    // ACP, so surface the bridge Install action instead of treating the agent
    // as installed/ready.
    if (check.fixType === "bridge") {
      readiness.set(providerId, "not_installed");
      continue;
    }

    // A bundled bridge vendors the full harness CLI, so it is the provider's
    // only binary and reports under `path`. Its bin dir is always on the
    // doctor PATH, so a healthy install resolves `path`; null means the
    // bundle itself is broken (packaging regression, wiped resources) and
    // sessions cannot spawn — treat that as not installed instead of masking
    // it as ready. Everything else accepts either binary of a two-binary
    // agent.
    const installed =
      (check.status === "pass" || check.status === "warn") &&
      (provider?.bundledBridge
        ? check.path != null
        : check.path != null || check.bridgePath != null);
    if (!installed) {
      readiness.set(providerId, "not_installed");
      continue;
    }

    // Three-case auth-readiness, gated on the curated catalog flags rather
    // than on authStatus alone. authStatus=null is overloaded (not-installed,
    // bridge-missing, genuine no-auth), so leaning on it would flip
    // supportsAuth-without-a-probe agents to "ready" pre-sign-in.
    if (provider?.supportsAuthStatus) {
      // Case 1: real CLI probe — trust the crate's authStatus. Only a probe
      // that actually reported "signed out" blocks the agent: `unknown` means
      // the probe could not run (a PATH-shadowed CLI), which the crate says to
      // treat as informational, so it stays usable and offers no sign-in fix.
      readiness.set(
        providerId,
        check.authStatus === "notAuthenticated" ? "not_ready" : "ready",
      );
      continue;
    }
    if (provider?.supportsAuth) {
      // Case 2: auth-capable but no real probe (e.g. copilot-acp) —
      // pessimistic default until the provider has an auth-status probe.
      readiness.set(providerId, "not_ready");
      continue;
    }
    // Case 3: no auth → ready once installed.
    readiness.set(providerId, "ready");
  }
  return readiness;
}

// Index the agent checks by frontend provider id, so cards can read their
// version/install-source readout from the same shared report.
function checksByProviderId(report: DoctorReport): Map<string, DoctorCheck> {
  const checks = new Map<string, DoctorCheck>();
  for (const check of report.checks) {
    const providerId = crateCheckIdToProviderId(check.id);
    if (providerId) checks.set(providerId, check);
  }
  return checks;
}

function readyIdsFromReadiness(
  readiness: Map<string, AgentProviderReadiness>,
): Set<string> {
  return new Set(
    [...readiness.entries()]
      .filter(([, status]) => status === "ready")
      .map(([id]) => id),
  );
}

const EMPTY_READINESS = new Map<string, AgentProviderReadiness>();

/**
 * The account model's word on an installed provider: ready while one of its
 * accounts is connected, not ready while none is. A provider whose accounts
 * Flock stores is ready only through a connected account. A provider whose
 * CLI keeps the sign-in is judged by its account status once the status
 * adapter has reported a state; until then, or where no adapter reports
 * one (Copilot, Amp), the harness probe in the doctor report stands.
 */
export function applyAccountReadiness(
  readiness: Map<string, AgentProviderReadiness>,
  providers: Record<string, ProviderAccountModel>,
  statuses: Record<string, ProviderAccountStatus>,
): Map<string, AgentProviderReadiness> {
  let next = readiness;
  for (const model of Object.values(providers)) {
    const installed = readiness.get(model.providerId);
    if (!installed || installed === "not_installed") continue;
    const reported = model.accounts.some((account) => {
      const state = statuses[account.id]?.state;
      return state !== undefined && state !== "unknown";
    });
    if (model.connection === "cli" && !reported) continue;
    const connected = model.accounts.some(
      (account) => account.enabled && accountIsConnected(statuses[account.id]),
    );
    const status = connected ? "ready" : "not_ready";
    if (installed === status) continue;
    if (next === readiness) next = new Map(readiness);
    next.set(model.providerId, status);
  }
  return next;
}

export function useAgentProviderStatus(): UseAgentProviderStatusReturn {
  const query = useDoctorReport();
  const providers = useProviderAccountsStore((state) => state.providersById);
  const statuses = useProviderAccountsStore((state) => state.statuses);

  const agentReadiness = useMemo(
    () =>
      applyAccountReadiness(
        query.data ? readinessFromReport(query.data) : EMPTY_READINESS,
        providers,
        statuses,
      ),
    [query.data, providers, statuses],
  );

  const readyAgentIds = useMemo(
    () => readyIdsFromReadiness(agentReadiness),
    [agentReadiness],
  );

  // Becoming ready is how a connected account shows up here; noting it lets a
  // new chat start on the account connected last (providerConnections).
  useEffect(() => {
    if (query.data) {
      recordReadyProviders(readyAgentIds);
    }
  }, [query.data, readyAgentIds]);

  const agentChecks = useMemo(() => {
    if (!query.data) return new Map<string, DoctorCheck>();
    return checksByProviderId(query.data);
  }, [query.data]);

  const refetch = query.refetch;
  const refresh = useCallback(async () => {
    const result = await refetch();
    const accountState = useProviderAccountsStore.getState();
    return applyAccountReadiness(
      result.data ? readinessFromReport(result.data) : EMPTY_READINESS,
      accountState.providersById,
      accountState.statuses,
    );
  }, [refetch]);

  return {
    readyAgentIds,
    agentReadiness,
    agentChecks,
    loading: query.isPending,
    statusUnavailable: query.isError,
    refresh,
  };
}
