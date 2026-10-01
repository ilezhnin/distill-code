import { useEffect, useState } from "react";
import { getClient } from "@/shared/api/acpConnection";
import type { ModelOption } from "@/features/chat/types";
import { providerModelOptionsFromInventory } from "../stores/providerModelCacheStore";

interface AccountModels {
  models: ModelOption[];
  updatedAt: number;
  error: string | null;
}
const cache = new Map<string, AccountModels>();
const requests = new Map<string, Promise<AccountModels>>();

// The account key keeps one chat's plan-specific models out of another chat.
export function useAccountModels(
  providerId: string,
  accountId: string | undefined,
  accountRevision: number | undefined,
  open: boolean,
) {
  const key = accountId
    ? `${providerId}\0${accountId}\0${accountRevision ?? 0}`
    : null;
  const [answer, setAnswer] = useState<{
    key: string;
    value: AccountModels;
  } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!key || !accountId || !open) return;
    const previous = cache.get(key);
    if (previous && Date.now() - previous.updatedAt < 30_000) {
      setAnswer({ key, value: previous });
      setPending(null);
      return;
    }
    let cancelled = false;
    setPending(key);
    let request = requests.get(key);
    if (!request) {
      request = getClient()
        .then((client) =>
          client.host.providersSupportedModelsList({ providerId, accountId }),
        )
        .then((response) => ({
          models: providerModelOptionsFromInventory(
            providerId,
            response.models,
          ),
          updatedAt: Date.now(),
          error: null,
        }))
        .catch((error: unknown) => ({
          models: [],
          updatedAt: Date.now(),
          error: String(error),
        }));
      requests.set(key, request);
      void request.then((value) => {
        cache.set(key, value);
        requests.delete(key);
        if (cache.size > 64) {
          const first = cache.keys().next().value;
          if (first) cache.delete(first);
        }
      });
    }
    void request.then((value) => {
      if (!cancelled) {
        setAnswer({ key, value });
        setPending(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [key, accountId, providerId, open]);
  const value = key
    ? answer?.key === key
      ? answer.value
      : cache.get(key)
    : undefined;
  return {
    models: key ? (value?.models ?? []) : null,
    error: value?.error ?? null,
    loading: key !== null && (pending === key || !value),
  };
}
