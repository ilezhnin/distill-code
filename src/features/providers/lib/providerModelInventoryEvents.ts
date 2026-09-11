type ProviderModelInventoryInvalidationListener = (providerId: string) => void;

const invalidationListeners =
  new Set<ProviderModelInventoryInvalidationListener>();

export function notifyProviderModelInventoryInvalidated(
  providerId: string,
): void {
  for (const listener of invalidationListeners) {
    listener(providerId);
  }
}
