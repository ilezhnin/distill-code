import { getCatalogEntry } from "../providerCatalog";

/**
 * Why an agent's model list is empty, when it is.
 *
 * `failed` is a poll that never came back with a list — the bridge did not
 * come up, or the agent answered with an error; `reason` carries the text the
 * poll produced. `empty` is a poll that did come back and named nothing. Both
 * used to look identical on screen, and identical to a provider that genuinely
 * serves no models, which left the operator guessing which had happened.
 */
export interface ProviderModelInventoryProblem {
  providerId: string;
  outcome: "empty" | "failed";
  reason?: string;
}

/**
 * A translation key plus its values, rather than finished text: the two call
 * sites open different i18next namespaces, and handing them a key keeps this
 * helper out of the business of typing someone else's `t`. The keys live in
 * the default `common` namespace so both reach them.
 */
export interface ProviderModelInventoryMessage {
  key: string;
  values: { provider: string; reason?: string };
}

/** One short line for the empty state, naming the provider and the cause. */
export function providerModelInventoryMessage(
  problem: ProviderModelInventoryProblem,
): ProviderModelInventoryMessage {
  const provider =
    getCatalogEntry(problem.providerId)?.displayName ?? problem.providerId;

  if (problem.outcome === "empty") {
    return { key: "modelInventory.reportedNone", values: { provider } };
  }

  // A failed poll usually carries the agent's own words; when it does not,
  // saying so beats a sentence that trails off into an empty quote.
  const reason = problem.reason?.trim();
  return reason
    ? { key: "modelInventory.pollFailed", values: { provider, reason } }
    : { key: "modelInventory.pollFailedUnknown", values: { provider } };
}
