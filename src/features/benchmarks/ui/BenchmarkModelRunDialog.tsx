import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
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
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { resolveCatchUpConfiguration } from "../lib/benchmarkCatchUp";
import { explicitEffort } from "../lib/benchmarkEffort";
import { authoredByCandidate } from "../lib/benchmarkEligibility";
import { modelDisplayName, providerVendor } from "../lib/benchmarkLabels";
import { plannedTurns, REQUIRED_REPETITIONS } from "../lib/benchmarkPlan";
import { runTimeLimitSeconds } from "../stores/benchmarkSettingsStore";
import type {
  Attempt,
  BenchmarkDefinition,
  BenchmarkVersion,
  Configuration,
  LeaderboardRow,
  RunRequest,
} from "../types";
import { BenchmarkAlert } from "./BenchmarkPrimitives";
import {
  ACTIVE_RUN,
  listByIds,
  passed,
  TestStatusMark,
  testStatus,
  useNow,
} from "./BenchmarkTestStatus";

/** Sorts a test the plan does not order after every test it does. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

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

/**
 * Runs one leaderboard model on the current tests. The model is the one the
 * page shows; every test it can be measured on and has not passed yet starts
 * checked, so a run asks for what failed or is missing. The list is in
 * the order the run takes the tests, and each row follows its test from
 * queued to running, with its elapsed time, to passed or failed.
 */
export function BenchmarkModelRunDialog({
  row,
  definitions,
  runId: activeRunId,
  onClose,
}: {
  /** The model's leaderboard row, as the leaderboard stands now. */
  row: LeaderboardRow;
  definitions: BenchmarkDefinition[];
  /** A run measuring this model now, followed instead of starting another. */
  runId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const configuration = row.configuration;
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
  // A click overrides a test's default until a run finishes.
  const [overrides, setOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );
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
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const requestFor = (
    versions: BenchmarkVersion[],
    candidate: Configuration,
  ): RunRequest => ({
    requestKey,
    versionIds: versions.map((version) => version.id),
    configurations: [candidate],
    repetitions: REQUIRED_REPETITIONS,
    timeoutSeconds: runTimeLimitSeconds(versions),
    maxExecutions: Math.max(
      1,
      plannedTurns(versions, candidate) * REQUIRED_REPETITIONS,
    ),
    preview: false,
  });
  const [runId, setRunId] = useState<string | null>(activeRunId);
  const run = useQuery({
    queryKey: [...benchmarkKeys, "run", runId],
    queryFn: () => benchmarkApi.getRun(runId as string),
    enabled: runId != null,
  });
  // The run's own attempts, in the order it dispatches them.
  const mine = useMemo(
    () =>
      (run.data?.attempts ?? []).filter((attempt) =>
        sameConfiguration(attempt.configuration, configuration),
      ),
    [run.data, configuration],
  );
  // Before a run, the plan names the order: the request key seeds it, and
  // leaving a test out never reorders the rest.
  const plan = useQuery({
    queryKey: [
      "benchmark-model-run-order",
      requestKey,
      pinned?.id ?? null,
      eligible.map((version) => version.id),
    ],
    queryFn: () =>
      benchmarkApi.previewRun(requestFor(eligible, pinned as Configuration)),
    enabled: pinned != null && eligible.length > 0 && mine.length === 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const ordered = useMemo(() => {
    const sequence =
      mine.length > 0
        ? mine.map((attempt) => attempt.versionId)
        : (plan.data?.executionOrder ?? []);
    const position = new Map<string, number>();
    sequence.forEach((id, index) => {
      if (!position.has(id)) position.set(id, index);
    });
    return [...eligible].sort(
      (a, b) =>
        (position.get(a.id) ?? UNORDERED) - (position.get(b.id) ?? UNORDERED),
    );
  }, [eligible, mine, plan.data]);
  // Summaries carry each attempt's score.
  const attemptIds = useMemo(() => mine.map((attempt) => attempt.id), [mine]);
  const summaries = useQuery({
    queryKey: [...benchmarkKeys, "run-attempts", runId, attemptIds],
    queryFn: () => listByIds(attemptIds),
    enabled: attemptIds.length > 0,
  });
  // The result each test stands at on the leaderboard, shown until a run
  // reports a newer one.
  const standingAttempts = useQuery({
    queryKey: [...benchmarkKeys, "standing", row.attemptIds],
    queryFn: () => listByIds(row.attemptIds),
    enabled: row.attemptIds.length > 0,
  });
  // The standing cell of each test: repetitions passed of those scored.
  const standing = useMemo(() => {
    const byVersion = new Map<string, number[]>();
    for (const summary of standingAttempts.data ?? []) {
      if (summary.score == null) continue;
      byVersion.set(summary.versionId, [
        ...(byVersion.get(summary.versionId) ?? []),
        summary.score,
      ]);
    }
    return new Map(
      [...byVersion].map(([versionId, values]) => [
        versionId,
        {
          kind: "scored" as const,
          score: values.reduce((sum, value) => sum + value, 0) / values.length,
          passes: values.filter(passed).length,
          of: values.length,
          graded: false,
          durationMs: null,
        },
      ]),
    );
  }, [standingAttempts.data]);
  // A test the model already solved on every repetition starts unchecked; a
  // failed, unscored or never measured one starts checked. Until the results
  // arrive nothing starts.
  const done = useMemo(
    () =>
      new Set(
        [...standing]
          .filter(([, cell]) => cell.passes === cell.of)
          .map(([versionId]) => versionId),
      ),
    [standing],
  );
  const resolvingStanding =
    row.attemptIds.length > 0 && standingAttempts.isPending;
  const scores = useMemo(
    () =>
      new Map(
        (summaries.data ?? []).map((summary) => [
          summary.id,
          summary.score ?? null,
        ]),
      ),
    [summaries.data],
  );
  const runActive = run.data ? ACTIVE_RUN.has(run.data.state) : false;
  const stopping = run.data?.state === "cancelling";
  // Following a run, the checks show the tests it holds.
  const inRunIds = useMemo(
    () => new Set(mine.map((attempt) => attempt.versionId)),
    [mine],
  );
  const following = runActive && mine.length > 0;
  const isChecked = (versionId: string) =>
    following
      ? inRunIds.has(versionId)
      : (overrides.get(versionId) ?? !done.has(versionId));
  const chosen = eligible.filter((version) => isChecked(version.id));
  // A finished run measured its tests: the next one starts from what is
  // still missing, as the refreshed leaderboard row names it.
  const wasActive = useRef(runActive);
  useEffect(() => {
    if (wasActive.current && !runActive) setOverrides(new Map());
    wasActive.current = runActive;
  }, [runActive]);
  const statuses = useMemo(() => {
    const byVersion = new Map<string, Attempt[]>();
    for (const attempt of mine) {
      byVersion.set(attempt.versionId, [
        ...(byVersion.get(attempt.versionId) ?? []),
        attempt,
      ]);
    }
    return new Map(
      [...byVersion].map(([versionId, attempts]) => [
        versionId,
        testStatus(attempts, scores, run.data?.state ?? null),
      ]),
    );
  }, [mine, scores, run.data]);
  const inRun = statuses.size;
  const settled = [...statuses.values()].filter(
    (status) => status?.kind === "scored" || status?.kind === "unscored",
  ).length;
  const busyTest = ordered.find((version) => {
    const kind = statuses.get(version.id)?.kind;
    return kind === "running" || kind === "judging";
  });
  // A running test's clock ticks every second.
  const now = useNow(busyTest != null);
  // Keep the test that runs now in view as the run moves down the list.
  const rows = useRef(new Map<string, HTMLLIElement>());
  const runningId = ordered.find((version) =>
    ["running", "waiting"].includes(statuses.get(version.id)?.kind ?? ""),
  )?.id;
  useEffect(() => {
    if (runningId)
      rows.current.get(runningId)?.scrollIntoView?.({ block: "nearest" });
  }, [runningId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!pinned || chosen.length === 0) return;
    setBusy(true);
    setError(null);
    // The checked tests in list order, so the plan order stays the queue.
    const request = requestFor(
      ordered.filter((version) => isChecked(version.id)),
      pinned,
    );
    try {
      const check = await benchmarkApi.previewRun(request);
      if (!check.valid) {
        setError(check.issues.join("\n"));
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
          <Label className="flex items-center gap-3 border-b border-border px-2 pb-2 text-sm font-medium">
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
                setOverrides(
                  new Map(
                    eligible.map((version) => [version.id, checked === true]),
                  ),
                )
              }
            />
            <span className="flex-1">{t("modelRun.allTests")}</span>
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {runActive || inRun > 0
                ? t("modelRun.finished", { settled, total: inRun })
                : t("modelRun.selected", {
                    selected: chosen.length,
                    total: eligible.length,
                  })}
            </span>
          </Label>
          <ol className="max-h-[55vh] overflow-y-auto">
            {ordered.map((version) => {
              const status = statuses.get(version.id) ?? null;
              const current =
                status?.kind === "running" ||
                status?.kind === "judging" ||
                status?.kind === "waiting";
              return (
                <li
                  key={version.id}
                  ref={(element) => {
                    if (element) rows.current.set(version.id, element);
                    else rows.current.delete(version.id);
                  }}
                  aria-current={current ? "step" : undefined}
                  className={cn("rounded-md", current && "bg-muted")}
                >
                  <Label className="flex items-center gap-3 px-2 py-1.5 text-sm font-normal">
                    <Checkbox
                      disabled={runActive}
                      checked={isChecked(version.id)}
                      onCheckedChange={(checked) =>
                        setOverrides((previous) =>
                          new Map(previous).set(version.id, checked === true),
                        )
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {version.manifest.name}
                    </span>
                    {status ? (
                      <TestStatusMark status={status} now={now} />
                    ) : standing.has(version.id) ? (
                      <span className="opacity-60">
                        <TestStatusMark
                          status={standing.get(version.id) ?? null}
                          now={now}
                        />
                      </span>
                    ) : null}
                  </Label>
                </li>
              );
            })}
            {authored.map((version) => (
              <li key={version.id}>
                <Label className="flex items-center gap-3 px-2 py-1.5 text-sm font-normal text-muted-foreground">
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
          </ol>
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
              disabled={
                busy || !pinned || resolvingStanding || chosen.length === 0
              }
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
