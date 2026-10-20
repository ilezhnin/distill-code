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
import {
  EXECUTION_PROFILES,
  type ExecutionProfile,
  executionProfileOf,
  resolveCatchUpConfiguration,
  stalePin,
} from "../lib/benchmarkCatchUp";
import { explicitEffort } from "../lib/benchmarkEffort";
import { authoredByCandidate } from "../lib/benchmarkEligibility";
import { currentVersions, isRankedSplit } from "../lib/benchmarkReleases";
import { useLocaleFormatting } from "@/shared/i18n";
import { modelDisplayName, providerVendor } from "../lib/benchmarkLabels";
import {
  plannedTurns,
  REQUIRED_REPETITIONS,
  runWindowCloses,
  runWindowOpen,
} from "../lib/benchmarkPlan";
import { runTimeLimitSeconds } from "../stores/benchmarkSettingsStore";
import type {
  Attempt,
  BenchmarkDefinitionSummary,
  BenchmarkVersionSummary,
  Configuration,
  InventoryModel,
  LeaderboardRow,
  RunRequest,
} from "../types";
import { BenchmarkAlert, StateBadge } from "./BenchmarkPrimitives";
import {
  ACTIVE_RUN,
  FINISHED_RUN,
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
 * Runs one leaderboard model on the current tests. A run is one sitting:
 * every test the model can be measured on starts checked, three repetitions
 * each. The model's newest run, while its 24-hour window is open (pauses
 * left out), is finished instead of replaced: its unfinished tests run the
 * repetitions they still owe, its complete ones stand. A complete run inside
 * its window warns that a new one measures everything again; a run whose
 * window closed says so and offers a new run for the tests it still owed. The list is in the order the
 * run takes the tests, and each row follows its test from queued to
 * running, with its elapsed time, to passed or failed.
 */
export function BenchmarkModelRunDialog({
  row,
  definitions,
  runId: activeRunId,
  onClose,
}: {
  /** The model's leaderboard row, as the leaderboard stands now. */
  row: LeaderboardRow;
  definitions: BenchmarkDefinitionSummary[];
  /** The model's newest run inside its window: followed, finished or warned about. */
  runId: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation("benchmarks");
  const { formatDate } = useLocaleFormatting();
  const client = useQueryClient();
  const configuration = row.configuration;
  const name = modelDisplayName(configuration);
  const effort = explicitEffort(configuration.effort);
  // Frozen leaderboard releases remain readable; new runs use current tests.
  // A test this model wrote runs too, tagged: the board counts only its
  // speed and cost.
  const { eligible, own } = useMemo(() => {
    const current = currentVersions(definitions)
      .filter((version) => isRankedSplit(version.manifest.split))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    return {
      eligible: current,
      own: new Set(
        current
          .filter((version) =>
            authoredByCandidate(version.manifest.environment, configuration),
          )
          .map((version) => version.id),
      ),
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
  // Each test runs on the model's configuration of its execution profile:
  // a text case on its text configuration, a repository case on its
  // repository one, both as today's inventory lists them.
  const resolutions = useMemo(
    () =>
      inventory.data
        ? new Map(
            EXECUTION_PROFILES.map((executionProfile) => [
              executionProfile,
              resolveCatchUpConfiguration(
                { ...configuration, executionProfile },
                inventory.data,
              ),
            ]),
          )
        : null,
    [inventory.data, configuration],
  );
  const pinnedFor = (profile: ExecutionProfile): Configuration | null => {
    const resolution = resolutions?.get(profile);
    return resolution && "configuration" in resolution
      ? resolution.configuration
      : null;
  };
  const profilesOf = (versions: readonly BenchmarkVersionSummary[]) =>
    EXECUTION_PROFILES.filter((profile) =>
      versions.some(
        (version) => executionProfileOf(version.manifest) === profile,
      ),
    );
  // The configurations a set of tests needs, one per profile; none while a
  // needed profile has no configuration today.
  const configurationsFor = (
    versions: readonly BenchmarkVersionSummary[],
  ): Configuration[] | null => {
    const needed = profilesOf(versions).map(pinnedFor);
    return needed.length > 0 && needed.every((entry) => entry != null)
      ? (needed as Configuration[])
      : null;
  };
  // Whatever the model can run today orders the plan.
  const listed = EXECUTION_PROFILES.flatMap((profile) => {
    const entry = pinnedFor(profile);
    return entry ? [entry] : [];
  });
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const requestFor = (
    versions: BenchmarkVersionSummary[],
    configurations: Configuration[],
  ): RunRequest => ({
    requestKey,
    versionIds: versions.map((version) => version.id),
    configurations,
    repetitions: REQUIRED_REPETITIONS,
    timeoutSeconds: runTimeLimitSeconds(versions),
    maxExecutions: Math.max(1, plannedTurns(versions) * REQUIRED_REPETITIONS),
    preview: false,
  });
  const [runId, setRunId] = useState<string | null>(activeRunId);
  const run = useQuery({
    queryKey: [...benchmarkKeys, "run", runId],
    queryFn: () => benchmarkApi.getRun(runId as string),
    enabled: runId != null,
  });
  // The run's own attempts, in the order it dispatches them; a repetition
  // superseded by a restart is no attempt of the run.
  const mine = useMemo(
    () =>
      (run.data?.attempts ?? []).filter(
        (attempt) =>
          attempt.outcome !== "superseded" &&
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
      listed.map((entry) => entry.id),
      eligible.map((version) => version.id),
    ],
    queryFn: () => benchmarkApi.previewRun(requestFor(eligible, listed)),
    enabled: listed.length > 0 && eligible.length > 0 && mine.length === 0,
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
  // The result each test stands at on the leaderboard, own tests included,
  // shown until a run reports a newer one.
  const standingIds = useMemo(
    () => [...row.attemptIds, ...(row.ownAttemptIds ?? [])],
    [row.attemptIds, row.ownAttemptIds],
  );
  const standingAttempts = useQuery({
    queryKey: [...benchmarkKeys, "standing", standingIds],
    queryFn: () => listByIds(standingIds),
    enabled: standingIds.length > 0,
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
          durationMs: null,
        },
      ]),
    );
  }, [standingAttempts.data]);
  const resolvingStanding =
    standingIds.length > 0 && standingAttempts.isPending;
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
  // The dialog's clock: a running test's timer and the window check.
  const clock = useNow(run.data != null);
  // The run's cells: a test is finished once every planned repetition
  // scored; one short of that keeps its scored repetitions and runs the
  // rest when the run goes on. A test its
  // provider may not receive, planned before that was known, is settled
  // unsent and never left to measure.
  const cells = useMemo(() => {
    const planned = Math.max(
      run.data?.request.repetitions ?? REQUIRED_REPETITIONS,
      REQUIRED_REPETITIONS,
    );
    const byVersion = new Map<string, number>();
    const inRun = new Set<string>();
    for (const attempt of mine) {
      inRun.add(attempt.versionId);
      if (scores.get(attempt.id) != null)
        byVersion.set(
          attempt.versionId,
          (byVersion.get(attempt.versionId) ?? 0) + 1,
        );
    }
    let left = 0;
    let partial = 0;
    // The repetitions the run still owes its unfinished tests.
    let remaining = 0;
    const complete = new Set<string>();
    for (const versionId of inRun) {
      const scored = byVersion.get(versionId) ?? 0;
      if (scored >= planned) {
        complete.add(versionId);
        continue;
      }
      left += 1;
      remaining += planned - scored;
      if (scored > 0) partial += 1;
    }
    return { left, partial, remaining, complete, measured: inRun.size - left };
  }, [mine, scores, run.data]);
  const windowOpen = run.data ? runWindowOpen(run.data, clock) : false;
  const resolvingRun =
    runId != null &&
    (run.isPending || (mine.length > 0 && summaries.isPending));
  const legacyRun =
    run.data != null && run.data.request.repetitions < REQUIRED_REPETITIONS;
  // Following a run, the checks show the tests it holds.
  const inRunIds = useMemo(
    () => new Set(mine.map((attempt) => attempt.versionId)),
    [mine],
  );
  // Tests the run never planned: inside its window they join it. One its
  // provider never receives is never missing.
  const missing = eligible.filter((version) => !inRunIds.has(version.id));
  // What the board already holds: a test is measured once its standing
  // cell, the newest scored one across all of the model's runs, holds every
  // required repetition. Passed or failed, it stands; a failure is a
  // measurement, and measuring only failures again would bias the board.
  // Only a test without such a cell is owed.
  // The board names its complete cases by their current version (a cell
  // carried from an earlier version included); an older row is read from
  // its standing cells.
  const measuredOnBoard = useMemo(
    () =>
      new Set(
        row.completeVersionIds ??
          [...standing]
            .filter(([, cell]) => cell.of >= REQUIRED_REPETITIONS)
            .map(([versionId]) => versionId),
      ),
    [row.completeVersionIds, standing],
  );
  // A test the model wrote is no case of its board: listed and runnable for
  // its speed and cost, never owed.
  const owedOnBoard = eligible.filter(
    (version) => !measuredOnBoard.has(version.id) && !own.has(version.id),
  );
  // The run was planned on a runtime the inventory no longer lists (an
  // older sandbox or CLI): the runner refuses every further test of it.
  // A run of both profiles carries both configurations: either one stale
  // stops it.
  const runConfigurations = (run.data?.request.configurations ?? []).filter(
    (entry) => sameConfiguration(entry, configuration),
  );
  const outdatedPin =
    inventory.data != null &&
    runConfigurations.some((entry) =>
      stalePin(entry, inventory.data as InventoryModel[]),
    );
  // A run that can no longer go on, its window closed or its runtime gone,
  // with tests it did not finish, is over: it says so, it can only be
  // stopped, and a new run takes what the model still owes.
  const unfinishedInRun = eligible.some(
    (version) => !cells.complete.has(version.id),
  );
  const expired =
    run.data != null &&
    !windowOpen &&
    !legacyRun &&
    mine.length > 0 &&
    !summaries.isPending &&
    unfinishedInRun;
  const outdated =
    !expired &&
    outdatedPin &&
    !legacyRun &&
    mine.length > 0 &&
    !summaries.isPending &&
    unfinishedInRun;
  const over = expired || outdated;
  // Until today's inventory answers, whether the run can go on is unknown:
  // Resume and Finish wait for it rather than risk a refusal.
  const pinUnknown =
    run.data != null && inventory.data == null && inventory.error == null;
  const stopped =
    !over &&
    windowOpen &&
    !legacyRun &&
    !runActive &&
    !stopping &&
    mine.length > 0 &&
    !summaries.isPending;
  // A run inside its window is finished, never replaced: its unfinished
  // tests start over, the tests it lacks join it. Only a run complete on
  // every current test is replaced, and knowingly.
  const finishing = stopped && (cells.left > 0 || missing.length > 0);
  const complete = stopped && cells.left === 0 && missing.length === 0;
  const following = !over && (runActive || finishing) && mine.length > 0;
  // What a test the run does not hold yet starts as: checked only while the
  // board owes it.
  const chosenByDefault = (versionId: string) =>
    overrides.get(versionId) ??
    (!measuredOnBoard.has(versionId) && !own.has(versionId));
  const locked = runActive && !over;
  const isChecked = (versionId: string) => {
    if (!following) return chosenByDefault(versionId);
    if (inRunIds.has(versionId)) return true;
    return finishing ? chosenByDefault(versionId) : false;
  };
  const chosen = eligible.filter((version) => isChecked(version.id));
  // The tests a finish adds to the run.
  const added = chosen.filter((version) => !inRunIds.has(version.id));
  // The attempts the main action pays for: a finish runs what the run owes
  // and three repetitions of each added test, a start three of each.
  const attempts = following
    ? cells.remaining + added.length * REQUIRED_REPETITIONS
    : chosen.length * REQUIRED_REPETITIONS;
  // Measuring every test again, complete ones included, is its own action.
  const everything = following
    ? cells.remaining + missing.length * REQUIRED_REPETITIONS
    : eligible.length * REQUIRED_REPETITIONS;
  const remeasurable = eligible.some((version) =>
    measuredOnBoard.has(version.id),
  );
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
  // A running test's clock ticks every second; the window check reads it too.
  const now = clock;
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
  const start = async (all = false) => {
    // The checked tests in list order, so the plan order stays the queue.
    const tests = ordered.filter(
      (version) => isChecked(version.id) || (all && eligible.includes(version)),
    );
    const configurations = configurationsFor(tests);
    if (!configurations || tests.length === 0) return;
    setBusy(true);
    setError(null);
    const request = requestFor(tests, configurations);
    try {
      const check = await benchmarkApi.previewRun(request);
      if (!check.valid) {
        setError(check.issues.join("\n"));
        return;
      }
      const started =
        complete && runId
          ? await benchmarkApi.startRun(request, runId)
          : await benchmarkApi.startRun(request);
      setRunId(started.id);
      setRequestKey(crypto.randomUUID());
      // The views refresh in the background: refetching every benchmark
      // query (the board included) can take seconds, and the controls must
      // stay usable meanwhile, Stop during a pause drain above all.
      void client.invalidateQueries({ queryKey: benchmarkKeys });
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
      void client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  // Pause lets the running attempts finish and starts no new one; resume
  // picks the run up where it stopped. The same rules as the run drawer.
  const control = async (act: (id: string) => Promise<unknown>) => {
    if (!runId) return;
    setBusy(true);
    setError(null);
    try {
      await act(runId);
      void client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  // A run that has not finished is steered here: paused, resumed or stopped.
  const runState = run.data?.state ?? null;
  const steering = runState != null && !FINISHED_RUN.has(runState);
  // A test of a profile the run does not carry brings the model's
  // configuration of that profile into the same run; none while that
  // profile has no configuration today.
  const joiningFor = (
    tests: readonly BenchmarkVersionSummary[],
  ): Configuration[] | null => {
    const carried = new Set(
      runConfigurations.map((entry) => entry.executionProfile),
    );
    const joining = profilesOf(tests)
      .filter((profile) => !carried.has(profile))
      .map(pinnedFor);
    return joining.every((entry) => entry != null)
      ? (joining as Configuration[])
      : null;
  };
  const finish = async (all = false) => {
    if (!runId) return;
    const tests = all ? missing : added;
    const joining = joiningFor(tests);
    if (!joining) return;
    setBusy(true);
    setError(null);
    try {
      await benchmarkApi.extendRun(
        runId,
        tests.map((version) => version.id),
        joining,
      );
      void client.invalidateQueries({ queryKey: benchmarkKeys });
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const allChecked = eligible.every((version) => isChecked(version.id));
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
          {/* Each profile the checked tests need and today's inventory
              cannot run says why; Start waits for it. */}
          {profilesOf(chosen).map((profile) => {
            const resolution = resolutions?.get(profile);
            if (!resolution || !("issue" in resolution)) return null;
            const model =
              profile === "protected_repository"
                ? t("modelRun.repositoryProfile", { model: name })
                : name;
            return (
              <BenchmarkAlert key={profile}>
                {resolution.issue === "unavailable"
                  ? (resolution.reason ?? t("states.unsupported"))
                  : t(
                      resolution.issue === "missing"
                        ? "run.catchUpMissing"
                        : "run.catchUpChanged",
                      { model },
                    )}
              </BenchmarkAlert>
            );
          })}
          {finishing && run.data ? (
            <p className="text-sm text-muted-foreground">
              {t("modelRun.finishHint", {
                at: formatDate(run.data.createdAt),
                until: formatDate(runWindowCloses(run.data, clock)),
                left: cells.left + added.length,
                partial: cells.partial,
              })}
            </p>
          ) : null}
          {expired && run.data ? (
            <BenchmarkAlert>
              {t("modelRun.expiredHint", {
                at: formatDate(run.data.createdAt),
                until: formatDate(runWindowCloses(run.data, clock)),
                owed: owedOnBoard.length,
              })}
            </BenchmarkAlert>
          ) : null}
          {outdated ? (
            <BenchmarkAlert>
              {t(
                steering
                  ? "modelRun.outdatedHint"
                  : "modelRun.outdatedStoppedHint",
                { owed: owedOnBoard.length },
              )}
            </BenchmarkAlert>
          ) : null}
          {!locked && !steering && !over ? (
            <p className="text-sm text-muted-foreground">
              {owedOnBoard.length > 0
                ? t("modelRun.owedHint", {
                    owed: owedOnBoard.length,
                    measured: eligible.length - owedOnBoard.length,
                  })
                : t("modelRun.allMeasuredHint")}
            </p>
          ) : null}
          {complete && run.data ? (
            <BenchmarkAlert>
              {t("modelRun.measuredHint", {
                at: formatDate(run.data.updatedAt),
                measured: cells.measured,
              })}
            </BenchmarkAlert>
          ) : null}
          <Label className="flex items-center gap-3 border-b border-border px-2 pb-2 text-sm font-medium">
            <Checkbox
              disabled={locked || eligible.length === 0}
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
            {steering ? <StateBadge state={runState} /> : null}
            <span className="text-xs font-normal text-muted-foreground tabular-nums">
              {runActive || steering
                ? t("modelRun.finished", { settled, total: inRun })
                : t("modelRun.toMeasure", {
                    selected: chosen.length,
                    total: eligible.length,
                    attempts,
                  })}
            </span>
          </Label>
          <ol className="max-h-[55vh] overflow-y-auto overscroll-contain scrollbar-visible [scrollbar-gutter:stable]">
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
                      disabled={
                        locked || (finishing && inRunIds.has(version.id))
                      }
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
                    {own.has(version.id) ? (
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        title={t("modelRun.authoredHint")}
                      >
                        {t("modelRun.authored")}
                      </span>
                    ) : null}
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
          </ol>
        </DialogBody>
        <DialogFooter>
          {steering && over ? (
            // A run that cannot go on is only stopped; Start follows.
            <Button
              type="button"
              variant="outline"
              destructive
              disabled={busy || stopping}
              onClick={() => void stop()}
            >
              {stopping ? t("modelRun.stopping") : t("modelRun.stop")}
            </Button>
          ) : steering ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={busy || runState !== "running"}
                onClick={() => void control(benchmarkApi.pauseRun)}
              >
                {t("actions.pause")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={
                  busy ||
                  pinUnknown ||
                  !["paused", "needs_attention", "planned"].includes(
                    runState ?? "",
                  )
                }
                onClick={() => void control(benchmarkApi.resumeRun)}
              >
                {t("actions.resume")}
              </Button>
              <Button
                type="button"
                variant="outline"
                destructive
                disabled={busy || stopping}
                onClick={() => void stop()}
              >
                {stopping ? t("modelRun.stopping") : t("modelRun.stop")}
              </Button>
              {/* A stopped run inside its window can also go on with the
                  tests it lacks, as the same run. */}
              {finishing ? (
                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    busy ||
                    pinUnknown ||
                    joiningFor(added) == null ||
                    (cells.left === 0 && added.length === 0)
                  }
                  onClick={() => void finish()}
                >
                  {t("modelRun.finish")}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              {/* Measuring complete tests again is asked for on its own,
                  with what it costs. */}
              {remeasurable ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    busy ||
                    (finishing
                      ? joiningFor(missing) == null
                      : !configurationsFor(eligible) ||
                        resolvingStanding ||
                        resolvingRun)
                  }
                  onClick={() => void (finishing ? finish(true) : start(true))}
                >
                  {t("modelRun.measureAll", { attempts: everything })}
                </Button>
              ) : null}
              {finishing ? (
                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    busy ||
                    pinUnknown ||
                    joiningFor(added) == null ||
                    (cells.left === 0 && added.length === 0)
                  }
                  onClick={() => void finish()}
                >
                  {t("modelRun.finish")}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="primary"
                  disabled={
                    busy ||
                    !configurationsFor(chosen) ||
                    resolvingStanding ||
                    resolvingRun ||
                    chosen.length === 0
                  }
                  onClick={() => void start()}
                >
                  {t("modelRun.start")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
