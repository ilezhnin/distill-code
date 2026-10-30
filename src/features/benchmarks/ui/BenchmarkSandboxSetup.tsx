import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import type { SandboxSetupAction, SandboxSetupState } from "../types";
import { BenchmarkAlert } from "./BenchmarkPrimitives";

export const sandboxSetupKey = [...benchmarkKeys, "sandbox-setup"] as const;

/**
 * The benchmark sandbox's setup state, kept current while a setup runs
 * (here or in another view), and the actions that change it.
 */
export function useSandboxSetup({
  providerId = null,
  onReady,
}: {
  /** Also renew this provider's offline policy check once ready. */
  providerId?: string | null;
  onReady?: () => void;
} = {}) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: sandboxSetupKey,
    queryFn: benchmarkApi.sandboxSetupStatus,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stop: (() => void) | undefined;
    let closed = false;
    void benchmarkApi
      .listenSandboxSetup(({ running, state }) => {
        if (running) {
          queryClient.setQueryData<SandboxSetupState>(
            sandboxSetupKey,
            (current) =>
              current
                ? { ...current, running }
                : {
                    stage: "unavailable",
                    action: null,
                    detail: null,
                    running,
                  },
          );
        } else if (state) {
          queryClient.setQueryData(sandboxSetupKey, state);
        } else {
          void queryClient.invalidateQueries({ queryKey: sandboxSetupKey });
        }
      })
      .then(
        (unlisten) => {
          if (closed) unlisten();
          else stop = unlisten;
        },
        // Without live progress the status still answers when asked.
        () => undefined,
      );
    return () => {
      closed = true;
      stop?.();
    };
  }, [queryClient]);
  const act = async (action: SandboxSetupAction) => {
    setStarting(true);
    setError(null);
    try {
      const next = await benchmarkApi.runSandboxSetup(action, providerId);
      queryClient.setQueryData(sandboxSetupKey, next);
      if (next.stage === "ready") onReady?.();
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
      void status.refetch();
    } finally {
      setStarting(false);
    }
  };
  const state = status.data ?? null;
  return {
    state,
    checking: status.isFetching && !state?.running,
    loadError: status.error ? benchmarkErrorMessage(status.error) : null,
    error,
    busy: starting || state?.running != null,
    act,
    check: () => {
      setError(null);
      void status.refetch();
    },
  };
}

type SandboxSetup = ReturnType<typeof useSandboxSetup>;

function actionLabel(state: SandboxSetupState): string | null {
  if (state.action === "installWsl") return "sandbox.actions.installWsl";
  if (state.action === "setUp")
    return state.stage === "notSetUp"
      ? "sandbox.actions.setUp"
      : "sandbox.actions.repair";
  return null;
}

/** What the sandbox needs, what is running, and what WSL reported. */
export function SandboxSetupStatus({ setup }: { setup: SandboxSetup }) {
  const { t } = useTranslation("benchmarks");
  const { state, loadError, error } = setup;
  const running = state?.running ?? null;
  const label = state ? actionLabel(state) : null;
  return (
    <div className="space-y-3 text-sm">
      {loadError ? <BenchmarkAlert>{loadError}</BenchmarkAlert> : null}
      {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
      {state == null && !loadError ? (
        <p className="text-muted-foreground">{t("sandbox.steps.checking")}</p>
      ) : null}
      {state && !running ? (
        <div className="space-y-1">
          <p className="font-medium">
            {t(`sandbox.stages.${state.stage}.title`)}
          </p>
          <p className="text-muted-foreground">
            {t(`sandbox.stages.${state.stage}.description`)}
          </p>
          {label ? (
            <p className="text-muted-foreground">
              {t(label.replace("actions", "actionHelp"))}
            </p>
          ) : null}
        </div>
      ) : null}
      {running ? (
        <div className="space-y-1" aria-live="polite">
          <p className="font-medium">{t(`sandbox.steps.${running.step}`)}</p>
          {running.line ? (
            <p className="truncate font-mono text-xs text-muted-foreground">
              {running.line}
            </p>
          ) : null}
          <p className="text-muted-foreground">{t("sandbox.runningHelp")}</p>
          {running.log.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-xs">
                {t("sandbox.log")}
              </summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                {running.log.join("\n")}
              </pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {state?.detail && !running ? (
        <details>
          <summary className="cursor-pointer text-xs">
            {t("detail.technical")}
          </summary>
          <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
            {state.detail}
          </p>
        </details>
      ) : null}
    </div>
  );
}

/** The action the app can take now, and a fresh check. */
export function SandboxSetupActions({
  setup,
  size = "default",
}: {
  setup: SandboxSetup;
  size?: "default" | "xs";
}) {
  const { t } = useTranslation("benchmarks");
  const { state, busy, checking } = setup;
  const label = state && !state.running ? actionLabel(state) : null;
  return (
    <>
      <Button
        type="button"
        variant={label ? "outline" : "primary"}
        size={size}
        disabled={busy || checking}
        onClick={setup.check}
      >
        {t(checking ? "sandbox.checking" : "sandbox.checkAgain")}
      </Button>
      {label && state?.action ? (
        <Button
          type="button"
          variant="primary"
          size={size}
          disabled={busy || checking}
          feedbackState={busy ? "loading" : "idle"}
          loadingLabel={t(label)}
          onClick={() => {
            if (state.action) void setup.act(state.action);
          }}
        >
          {t(label)}
        </Button>
      ) : null}
    </>
  );
}

/** The sandbox setup, on its own surface above a run dialog. */
export function SandboxSetupDialog({
  open,
  onOpenChange,
  providerId,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerId: string | null;
  onReady: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const setup = useSandboxSetup({
    providerId,
    onReady: () => {
      onReady();
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{t("sandbox.title")}</DialogTitle>
          <DialogDescription>{t("sandbox.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SandboxSetupStatus setup={setup} />
        </DialogBody>
        <DialogFooter>
          <SandboxSetupActions setup={setup} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Inside a run dialog's readiness alert: when the sandbox is what blocks
 * the run, say what it needs and open its setup.
 */
export function SandboxSetupPrompt({
  providerId,
  onReady,
}: {
  providerId: string | null;
  onReady: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { state } = useSandboxSetup();
  const [open, setOpen] = useState(false);
  if (state == null || (state.stage === "ready" && !state.running)) return null;
  const label = state.running
    ? "sandbox.showProgress"
    : (actionLabel(state) ?? "sandbox.open");
  return (
    <>
      <p>
        {t(
          state.running
            ? `sandbox.steps.${state.running.step}`
            : `sandbox.stages.${state.stage}.title`,
        )}
      </p>
      <Button
        type="button"
        variant="alert"
        size="xs"
        onClick={() => setOpen(true)}
      >
        {t(label)}
      </Button>
      <SandboxSetupDialog
        open={open}
        onOpenChange={setOpen}
        providerId={providerId}
        onReady={onReady}
      />
    </>
  );
}
