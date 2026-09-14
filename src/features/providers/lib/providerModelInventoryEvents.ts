export type ProviderModelInventoryInvalidationListener = (
  providerId: string,
) => void;

const invalidationListeners =
  new Set<ProviderModelInventoryInvalidationListener>();

/**
 * Watch for "the model list you were holding for this provider is gone".
 *
 * Returns the unsubscribe function. Until this existed the module had no way
 * to add a listener at all, so every `notify` call was a permanent no-op. The
 * cache's own correctness still does not depend on a subscriber existing: a
 * persisted entry is dropped on a `schemaVersion` mismatch and rewritten on a
 * changed `revision` whether or not anyone is listening.
 */
export function subscribeProviderModelInventoryInvalidated(
  listener: ProviderModelInventoryInvalidationListener,
): () => void {
  invalidationListeners.add(listener);
  return () => {
    invalidationListeners.delete(listener);
  };
}

export function notifyProviderModelInventoryInvalidated(
  providerId: string,
): void {
  // Iterate a copy: a listener is free to unsubscribe itself from here.
  for (const listener of [...invalidationListeners]) {
    listener(providerId);
  }
}
