import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { providerDisplayName } from "@/features/providers/providerCatalog";
import { Button } from "@/shared/ui/button";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import type { SandboxSignInState } from "../types";

const signInKey = (providerId: string, accountId: string) =>
  [...benchmarkKeys, "sandbox-sign-in", providerId, accountId] as const;

/**
 * What a run dialog offers for the account's sign-in inside the sandbox:
 * nothing when the provider signs in in Flock or the sandbox could not be
 * checked; the sign-in when the sandbox lacks it; a wait while its window
 * is open.
 */
export function sandboxSignInOffer(
  state: SandboxSignInState | null,
): "none" | "signIn" | "waiting" {
  if (!state?.required) return "none";
  if (state.open) return "waiting";
  return state.signedIn === false ? "signIn" : "none";
}

/**
 * The account's sandbox sign-in, kept current when its window closes
 * (from here or another dialog), and the action that opens that window.
 */
export function useSandboxSignIn({
  providerId,
  accountId,
  onSignedIn,
}: {
  providerId: string;
  accountId: string;
  onSignedIn: () => void;
}) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: signInKey(providerId, accountId),
    queryFn: () => benchmarkApi.sandboxSignInStatus(providerId, accountId),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The window closed and the sandbox still lacks the sign-in.
  const [unfinished, setUnfinished] = useState(false);
  // Counts closed windows, so a close reported before the open call
  // answered is not overwritten by that answer.
  const closes = useRef(0);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;
  useEffect(() => {
    let stop: (() => void) | undefined;
    let closed = false;
    void benchmarkApi
      .listenSandboxSignIn((event) => {
        if (event.providerId !== providerId || event.accountId !== accountId)
          return;
        closes.current += 1;
        queryClient.setQueryData(signInKey(providerId, accountId), event.state);
        setUnfinished(event.state.signedIn === false);
        // Signed in, or the sandbox could not be observed: availability
        // says what it needs now.
        if (event.state.signedIn !== false) signedIn.current();
      })
      .then(
        (unlisten) => {
          if (closed) unlisten();
          else stop = unlisten;
        },
        // Without the event the state still answers when checked again.
        () => undefined,
      );
    return () => {
      closed = true;
      stop?.();
    };
  }, [queryClient, providerId, accountId]);
  const open = async () => {
    setOpening(true);
    setError(null);
    setUnfinished(false);
    const before = closes.current;
    try {
      const next = await benchmarkApi.openSandboxSignIn(providerId, accountId);
      if (closes.current === before)
        queryClient.setQueryData(signInKey(providerId, accountId), next);
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
      void status.refetch();
    } finally {
      setOpening(false);
    }
  };
  return {
    state: status.data ?? null,
    opening,
    error,
    unfinished,
    open,
  };
}

/**
 * Inside a run dialog's readiness alert: when the sandbox lacks the
 * account's own sign-in (Kimi keeps one there), open the provider's
 * sign-in in a window of its own, then check availability again.
 */
export function SandboxSignInPrompt({
  providerId,
  accountId,
  onSignedIn,
}: {
  providerId: string;
  accountId: string;
  onSignedIn: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const signIn = useSandboxSignIn({ providerId, accountId, onSignedIn });
  const offer = sandboxSignInOffer(signIn.state);
  if (offer === "none") return null;
  const provider = providerDisplayName(providerId);
  return (
    <>
      <p>{t("sandbox.signIn.title", { provider })}</p>
      <p>
        {t(
          offer === "waiting"
            ? "sandbox.signIn.waiting"
            : signIn.unfinished
              ? "sandbox.signIn.unfinished"
              : "sandbox.signIn.help",
          { provider },
        )}
      </p>
      {signIn.error ? <p>{signIn.error}</p> : null}
      <Button
        type="button"
        variant="alert"
        size="xs"
        disabled={offer === "waiting" || signIn.opening}
        feedbackState={signIn.opening ? "loading" : "idle"}
        loadingLabel={t("sandbox.signIn.action", { provider })}
        onClick={() => void signIn.open()}
      >
        {t(
          offer === "waiting"
            ? "sandbox.signIn.windowOpen"
            : "sandbox.signIn.action",
          { provider },
        )}
      </Button>
    </>
  );
}
