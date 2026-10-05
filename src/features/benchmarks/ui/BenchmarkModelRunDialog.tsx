import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { IconCheck, IconX } from "@tabler/icons-react";
import { cn } from "@/shared/lib/cn";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { Label } from "@/shared/ui/label";
import { Spinner } from "@/shared/ui/spinner";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { resolveCatchUpConfiguration } from "../lib/benchmarkCatchUp";
import { explicitEffort } from "../lib/benchmarkEffort";
import { authoredByCandidate } from "../lib/benchmarkEligibility";
import {
  modelDisplayName,
  providerVendor,
  stateLabel,
} from "../lib/benchmarkLabels";
import { plannedTurns } from "../lib/benchmarkPlan";
import { runTimeLimitSeconds } from "../stores/benchmarkSettingsStore";
import type {
  AttemptSummary,
  BenchmarkDefinition,
  BenchmarkVersion,
  Configuration,
  RunRequest,
} from "../types";
import { BenchmarkAlert } from "./BenchmarkPrimitives";

/** Attempt phases between dispatch and a settled answer. */
const WORKING = new Set(["preparing", "dispatching", "running", "collecting"]);
/** Run states in which attempts still start or finish. */
const ACTIVE_RUN = new Set(["planned", "running", "pausing"]);

type TestStatus =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "judging" }
  | { kind: "scored"; score: number }
  | { kind: "unscored"; outcome: string | null };

/** Whether an attempt ran on the model, effort and fast mode a row names. */
function sameConfiguration(a: Configuration, b: Configuration): boolean {
  return (
    a.providerId === b.providerId &&
    (a.accountId ?? null) === (b.accountId ?? null) &&
    a.modelId === b.modelId &&
    explicitEffort(a.effort) === explicitEffort(b.effort) &&
    (a.fastMode ?? false) === (b.fastMode ?? false)
  );
}

/** One test's state across its attempts in the run. */
function testStatus(
  attempts: AttemptSummary[],
  runActive: boolean,
): TestStatus | null {
  if (attempts.length === 0) return null;
  if (attempts.some((a) => WORKING.has(a.phase))) return { kind: "running" };
  if (
    attempts.some(
      (a) => a.phase === "awaiting_judges" || a.outcome === "pending_review",
    )
  )
    return { kind: "judging" };
  if (attempts.some((a) => a.phase === "pending"))
    return runActive
      ? { kind: "queued" }
      : { kind: "unscored", outcome: "cancelled" };
  const scores = attempts.flatMap((a) => (a.score == null ? [] : [a.score]));
  if (scores.length > 0)
    return {
      kind: "scored",
      score: scores.reduce((sum, value) => sum + value, 0) / scores.length,
    };
  return { kind: "unscored", outcome: attempts[0].outcome };
}

/**
 * Runs one leaderboard model on the current tests. The model is the one the
 * page shows; every test it can be measured on starts checked, and each row
 * follows its test from queued to passed or failed.
 */
export function BenchmarkModelRunDialog({
  configuration,
  definitions,
  runId: activeRunId,
  onClose,
}: {
  configuration: Configuration;
  definitions: BenchmarkDefinition[];
  /** A run measuring this model now, followed instead of starting another. */
  runId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const name = modelDisplayName(configuration);
  const effort = explicitEffort(configuration.effort);
  // The current pool: the newest published version of every live test, the
  // ones this model can be measured on first.
  const { eligible, authored } = useMemo(() => {
    const current = definitions
      .filter((definition) => !definition.archived)
      .flatMap((definition) =>
        [...definition.versions]
          .sort((a, b) => b.publishedAt - a.publishedAt)
          .slice(0, 1),
      )
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    const wrote = (version: BenchmarkVersion) =>
      authoredByCandidate(version.manifest.environment, configuration);
    return {
      eligible: current.filter((version) => !wrote(version)),
      authored: current.filter(wrote),
    };
  }, [definitions, configuration]);
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const chosen = eligible.filter((version) => !unchecked.has(version.id));
  // The row carries the runtime of its newest attempt; run its model as
  // today's inventory lists it, so the runner does not refuse a stale pin.
  const inventory = useQuery({
    queryKey: [
      "benchmark-catch-up-inventory",
      configuration.providerId,
      configuration.accountId ?? null,
    ],
    queryFn: () =>
      benchmarkApi.getInventory(
        configuration.providerId,
        configuration.accountId ?? null,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });
  const resolution = inventory.data
    ? resolveCatchUpConfiguration(configuration, inventory.data)
    : null;
  const pinned =
    resolution && "configuration" in resolution
      ? resolution.configuration
      : null;
  const [runId, setRunId] = useState<string | null>(activeRunId);
  const run = useQuery({
    queryKey: [...benchmarkKeys, "run", runId],
    queryFn: () => benchmarkApi.getRun(runId as string),
    enabled: runId != null,
  });
  const attemptIds = useMemo(
    () =>
      (run.data?.attempts ?? [])
        .filter((attempt) =>
          sameConfiguration(attempt.configuration, configuration),
        )
        .map((attempt) => attempt.id),
    [run.data, configuration],
  );
  // Summaries carry each attempt's score; a listing returns at most 100.
  const summaries = useQuery({
    queryKey: [...benchmarkKeys, "run-attempts", runId, attemptIds],
    queryFn: async () => {
      const pages: AttemptSummary[][] = [];
      for (let start = 0; start < attemptIds.length; start += 100) {
        const ids = attemptIds.slice(start, start + 100);
        pages.push(
          await benchmarkApi.listAttempts({ attemptIds: ids, limit: 100 }),
        );
      }
      return pages.flat();
    },
    enabled: attemptIds.length > 0,
  });
  const runActive = run.data ? ACTIVE_RUN.has(run.data.state) : false;
  const stopping = run.data?.state === "cancelling";
  const inRun = new Set(
    (summaries.data ?? []).map((attempt) => attempt.versionId),
  );
  const statusOf = (versionId: string) =>
    testStatus(
      (summaries.data ?? []).filter(
        (attempt) => attempt.versionId === versionId,
      ),
      runActive,
    );
  const settled = eligible.filter((version) => {
    const status = statusOf(version.id);
    return status?.kind === "scored" || status?.kind === "unscored";
  }).length;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const start = async () => {
    if (!pinned || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    const request: RunRequest = {
      requestKey,
      versionIds: chosen.map((version) => version.id),
      configurations: [pinned],
      repetitions: 1,
      timeoutSeconds: runTimeLimitSeconds(chosen),
      maxExecutions: plannedTurns(chosen, pinned),
      preview: false,
    };
    try {
      const plan = await benchmarkApi.previewRun(request);
      if (!plan.valid) {
        setError(plan.issues.join("\n"));
        return;
      }
      const started = await benchmarkApi.startRun(request);
      setRunId(started.id);
      setRequestKey(crypto.randomUUID());
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      await benchmarkApi.cancelRun(runId);
      await client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const allChecked = chosen.length === eligible.length;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="shrink-0">
              {getProviderIcon(configuration.providerId, "size-5")}
            </span>
            <span>{name}</span>
            {effort ? <Badge variant="outline">{effort}</Badge> : null}
            {configuration.fastMode ? (
              <Badge variant="outline">{t("fastMode")}</Badge>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            {providerVendor(configuration.providerId)}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {error ? <BenchmarkAlert>{error}</BenchmarkAlert> : null}
          {inventory.error ? (
            <BenchmarkAlert>
              {benchmarkErrorMessage(inventory.error)}
            </BenchmarkAlert>
          ) : null}
          {resolution && "issue" in resolution ? (
            <BenchmarkAlert>
              {resolution.issue === "unavailable"
                ? (resolution.reason ?? t("states.unsupported"))
                : t(
                    resolution.issue === "missing"
                      ? "run.catchUpMissing"
                      : "run.catchUpChanged",
                    { model: name },
                  )}
            </BenchmarkAlert>
          ) : null}
          <Label className="flex items-center gap-3 border-b border-border pb-2 text-sm font-medium">
            <Checkbox
              disabled={runActive || eligible.length === 0}
              checked={
                allChecked
                  ? eligible.length > 0
                  : chosen.length === 0
                    ? false
                    : "indeterminate"
              }
              onCheckedChange={(checked) =>
                setUnchecked(
                  checked === true
                    ? new Set()
                    : new Set(eligible.map((version) => version.id)),
                )
              }
            />
            <span className="flex-1">{t("modelRun.allTests")}</span>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {runActive || inRun.size > 0
                ? t("modelRun.finished", {
                    settled,
                    total: inRun.size,
                  })
                : t("modelRun.selected", {
                    selected: chosen.length,
                    total: eligible.length,
                  })}
            </span>
          </Label>
          <ul className="max-h-[55vh] overflow-y-auto">
            {eligible.map((version) => (
              <li key={version.id}>
                <Label className="flex items-center gap-3 py-1.5 text-sm font-normal">
                  <Checkbox
                    disabled={runActive}
                    checked={!unchecked.has(version.id)}
                    onCheckedChange={(checked) =>
                      setUnchecked((previous) => {
                        const next = new Set(previous);
                        if (checked === true) next.delete(version.id);
                        else next.add(version.id);
                        return next;
                      })
                    }
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {version.manifest.name}
                  </span>
                  <TestStatusMark status={statusOf(version.id)} />
                </Label>
              </li>
            ))}
            {authored.map((version) => (
              <li key={version.id}>
                <Label className="flex items-center gap-3 py-1.5 text-sm font-normal text-muted-foreground">
                  <Checkbox disabled checked={false} />
                  <span className="min-w-0 flex-1 truncate">
                    {version.manifest.name}
                  </span>
                  <span className="shrink-0 text-xs">
                    {t("modelRun.authored")}
                  </span>
                </Label>
              </li>
            ))}
          </ul>
        </DialogBody>
        <DialogFooter>
          {runActive || stopping ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || stopping}
              onClick={() => void stop()}
            >
              {stopping ? t("modelRun.stopping") : t("modelRun.stop")}
            </Button>
          ) : (
            <Button
              type="button"
              variant="primary"
              disabled={busy || !pinned || chosen.length === 0}
              onClick={() => void start()}
            >
              {t("modelRun.start")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TestStatusMark({ status }: { status: TestStatus | null }) {
  const { t } = useTranslation("benchmarks");
  if (!status) return null;
  switch (status.kind) {
    case "queued":
      return (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t("modelRun.queued")}
        </span>
      );
    case "running":
      return (
        <Spinner
          aria-label={t("modelRun.running")}
          className="size-4 shrink-0 text-chart-1"
        />
      );
    case "judging":
      return (
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          <Spinner decorative className="size-3.5" />
          {t("modelRun.judging")}
        </span>
      );
    case "scored":
      if (status.score >= 1)
        return (
          <IconCheck
            aria-label={t("states.pass")}
            className="size-4 shrink-0 text-success"
          />
        );
      if (status.score <= 0)
        return (
          <IconX
            aria-label={t("states.fail")}
            className="size-4 shrink-0 text-destructive"
          />
        );
      return (
        <span
          className={cn(
            "shrink-0 text-sm font-medium tabular-nums",
            status.score >= 0.5 ? "text-success" : "text-destructive",
          )}
        >
          {Math.round(status.score * 1000)}
        </span>
      );
    case "unscored":
      return (
        <span className="shrink-0 text-xs text-muted-foreground">
          {stateLabel(t, status.outcome)}
        </span>
      );
  }
}
