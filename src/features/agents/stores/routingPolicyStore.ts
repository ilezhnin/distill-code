/**
 * The live routing policy: read everywhere a model is chosen, edited in one
 * settings pane, persisted as a document in the Distill folder.
 *
 * Hydration follows the same rule as every other document store here — the
 * store starts on the defaults and refuses to write until its read has landed,
 * because an empty policy persisted over a full one during startup would
 * quietly discard the operator's thresholds.
 */

import { create } from "zustand";

import { distillDocument } from "@/shared/lib/distillDocument";

import type { ModelPreferenceClassId } from "../lib/modelRanking";
import {
  DEFAULT_ROUTING_POLICY,
  ROUTING_POLICY_DOCUMENT,
  parseRoutingPolicy,
  type RoutingPolicy,
} from "../lib/routingPolicy";

/** Where the policy lived before it was a document. Read once, then removed. */
const ROUTING_POLICY_STORAGE_KEY = "goose:routing-policy";

const document = distillDocument<RoutingPolicy>({
  path: ROUTING_POLICY_DOCUMENT,
  legacyStorageKey: ROUTING_POLICY_STORAGE_KEY,
  parse: parseRoutingPolicy,
  serialize: (policy) => policy,
});

interface RoutingPolicyState {
  policy: RoutingPolicy;
  /** False until the stored document has been read. Writes wait for it. */
  hydrated: boolean;
  setThreshold: (
    key: "waveNearLimitPercent" | "chatNearLimitPercent",
    percent: number,
  ) => void;
  setClassOverride: (
    classId: ModelPreferenceClassId,
    labels: readonly string[] | null,
  ) => void;
  resetPolicy: () => void;
}

function persist(policy: RoutingPolicy, hydrated: boolean): void {
  if (hydrated) document.write(policy);
}

export const useRoutingPolicyStore = create<RoutingPolicyState>((set, get) => ({
  policy: { ...DEFAULT_ROUTING_POLICY },
  hydrated: false,
  setThreshold: (key, percent) =>
    set((state) => {
      const policy = parseRoutingPolicy({ ...state.policy, [key]: percent });
      persist(policy, state.hydrated);
      return { policy };
    }),
  setClassOverride: (classId, labels) =>
    set((state) => {
      const classOverrides = { ...state.policy.classOverrides };
      // An empty list is a removal, not an empty ranking: a class the operator
      // emptied should fall back to the built-in list rather than resolve to
      // nothing and silently inherit whatever the session was on.
      if (!labels || labels.length === 0) delete classOverrides[classId];
      else classOverrides[classId] = [...labels];
      const policy = { ...state.policy, classOverrides };
      persist(policy, state.hydrated);
      return { policy };
    }),
  resetPolicy: () => {
    const policy = { ...DEFAULT_ROUTING_POLICY };
    persist(policy, get().hydrated);
    set({ policy });
  },
}));

export async function hydrateRoutingPolicyStore(): Promise<void> {
  const stored = await document.read();
  useRoutingPolicyStore.setState({
    policy: stored ?? { ...DEFAULT_ROUTING_POLICY },
    hydrated: true,
  });
}

export function flushRoutingPolicyWrites(): Promise<void> {
  return document.flush();
}

/** The policy, without subscribing. For the resolution paths. */
export function getRoutingPolicy(): RoutingPolicy {
  return useRoutingPolicyStore.getState().policy;
}

export function resetRoutingPolicyForTests(): void {
  useRoutingPolicyStore.setState({
    policy: { ...DEFAULT_ROUTING_POLICY },
    hydrated: false,
  });
}
