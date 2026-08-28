import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CircleCheckBig,
  Coins,
  GitBranch,
  Layers,
  Timer,
  Waves,
} from "lucide-react";

import {
  buildWaveTelemetrySummary,
  type WaveTelemetryWindow,
} from "@/features/conductor/waveTelemetryModel";
import {
  buildFactsLedger,
  MIN_FACT_OBSERVATIONS,
} from "@/features/conductor/factsLedger";
import {
  isPersistHealthy,
  totalPersistFailures,
  usePersistHealth,
} from "@/features/conductor/persistHealth";
import {
  MAX_WAVE_TELEMETRY_RECORDS,
  type WaveTelemetryState,
} from "@/features/conductor/waveTelemetryStore";
import {
  formatUsageCost,
  formatUsagePercent,
  formatUsageTokens,
  formatWorkedDuration,
} from "@/features/stats/lib/usageFormatters";
import { Button } from "@/shared/ui/button";

import { StatCard } from "./StatCard";

const WINDOWS: readonly WaveTelemetryWindow[] = [1, 7, 30, null];

/**
 * The first reader wave telemetry has ever had.
 *
 * The store has been collecting since the closed loop shipped, and until now
 * the only way to see any of it was devtools. That is why six product
 * questions — where the complexity gate belongs, what orchestration multiplies
 * a request's cost by, how often the fenced format breaks — are still
 * opinions: the answers were in localStorage the whole time.
 *
 * All arithmetic is in `waveTelemetryModel`; this file only renders it, so a
 * number the operator disputes can be re-derived from the same records
 * without a browser.
 */
export function WaveTelemetryPane({
  telemetry,
}: {
  telemetry: WaveTelemetryState;
}) {
  const { t } = useTranslation("settings");
  const [window, setWindow] = useState<WaveTelemetryWindow>(7);
  const unavailable = t("stats.waves.noData");
  const summary = useMemo(
    () => buildWaveTelemetrySummary(telemetry, { window }),
    [telemetry, window],
  );
  const persist = usePersistHealth();
  // Over every record, not the selected window: these are the facts handed to
  // the conductor, and it is handed all of them.
  const facts = useMemo(
    () => buildFactsLedger(telemetry.records),
    [telemetry.records],
  );

  const duration = (ms: number | null) =>
    ms === null
      ? unavailable
      : formatWorkedDuration(ms, {
          zero: t("stats.duration.zero"),
          daysHours: (days, hours) =>
            t("stats.duration.daysHours", { days, hours }),
          hoursMinutes: (hours, minutes) =>
            t("stats.duration.hoursMinutes", { hours, minutes }),
          minutesSeconds: (minutes, seconds) =>
            t("stats.duration.minutesSeconds", { minutes, seconds }),
          seconds: (seconds) => t("stats.duration.seconds", { seconds }),
        });

  const { lifetime } = summary;
  const histogram = summary.stepCountHistogram;

  return (
    <section
      className="rounded-lg border border-border/60 bg-card/30 p-4"
      data-testid="wave-telemetry-pane"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">
            {t("stats.waves.title")}
          </h3>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {t("stats.waves.description")}
          </p>
        </div>
        <fieldset
          className="flex shrink-0 gap-1 border-0 p-0"
          aria-label={t("stats.waves.window.label")}
        >
          {WINDOWS.map((candidate) => (
            <Button
              key={candidate ?? "all"}
              type="button"
              size="xs"
              variant={candidate === window ? "subtle" : "ghost"}
              aria-pressed={candidate === window}
              onClick={() => setWindow(candidate)}
            >
              {t(`stats.waves.window.${candidate ?? "all"}`)}
            </Button>
          ))}
        </fieldset>
      </div>

      {/* Lifetime block first: these are the numbers the protocol's own
          thresholds are written against, and they do not move with the
          period — which the note says out loud rather than leaving the
          reader to assume the whole pane shares one clock. */}
      {!isPersistHealthy(persist) && (
        // The one standing surface for P18. The transcript notice is said
        // once and scrolls away; this stays as long as the condition does.
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground"
          data-testid="wave-telemetry-persist-warning"
        >
          {t("stats.waves.persistBroken", {
            count: totalPersistFailures(persist),
          })}
        </p>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        {t("stats.waves.lifetimeNote")}
      </p>
      <div className="mt-2 grid gap-3 md:grid-cols-3">
        <StatCard
          label={t("stats.waves.orchestrationRate")}
          value={formatUsagePercent(lifetime.orchestrationRate, unavailable)}
          icon={<Waves className="size-4" />}
        />
        <StatCard
          label={t("stats.waves.formatReliability")}
          value={formatUsagePercent(lifetime.formatReliability, unavailable)}
          icon={<CircleCheckBig className="size-4" />}
        />
        <StatCard
          label={t("stats.waves.concurrentRefusals")}
          value={`${lifetime.concurrentRefusals}`}
          icon={<GitBranch className="size-4" />}
        />
      </div>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        <li>
          {t("stats.waves.orchestrationRateHint", {
            waves: lifetime.admittedWaves,
            answers: lifetime.planlessTurns,
          })}
        </li>
        <li>
          {t("stats.waves.formatReliabilityHint", {
            admitted: lifetime.admittedWaves,
            rejected: lifetime.rejectedPlans,
          })}
        </li>
      </ul>

      {summary.waveCount === 0 ? (
        <p className="mt-4 rounded-md border border-border/50 bg-card/50 px-3 py-2 text-xs text-muted-foreground">
          {t("stats.waves.empty")}
        </p>
      ) : (
        <>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <StatCard
              label={t("stats.waves.waveCount")}
              value={`${summary.waveCount}`}
              icon={<Waves className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.acceptRate")}
              value={formatUsagePercent(summary.acceptRate, unavailable)}
              icon={<CircleCheckBig className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.revisionRate")}
              value={formatUsagePercent(summary.revisionRate, unavailable)}
              icon={<GitBranch className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.meanSteps")}
              value={
                summary.meanStepsPerWave === null
                  ? unavailable
                  : summary.meanStepsPerWave.toFixed(1)
              }
              icon={<Layers className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.medianStep")}
              value={duration(summary.medianStepDurationMs)}
              icon={<Timer className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.p90Step")}
              value={duration(summary.p90StepDurationMs)}
              icon={<Timer className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.tokens")}
              value={formatUsageTokens(summary.totalTokens)}
              icon={<Coins className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.cost")}
              value={formatUsageCost(summary.totalCostUsd, unavailable)}
              icon={<Coins className="size-4" />}
            />
            <StatCard
              label={t("stats.waves.degradedSteps")}
              value={formatUsagePercent(summary.degradedStepRate, unavailable)}
              icon={<Layers className="size-4" />}
            />
          </div>

          <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
            <li>
              {t("stats.waves.rootRequests", {
                count: summary.rootRequestCount,
              })}
              {" · "}
              {t("stats.waves.outcomeBreakdown", {
                accepted: summary.outcomes.accepted,
                revised: summary.outcomes.revised,
                needsOperator: summary.outcomes["needs-operator"],
                pruned: summary.outcomes.pruned,
              })}
            </li>
            <li>
              <span className="sr-only">
                {t("stats.waves.stepHistogramLabel")}
              </span>
              {t("stats.waves.stepHistogram", {
                one: histogram[0],
                two: histogram[1],
                three: histogram[2],
                four: histogram[3],
                five: histogram[4],
              })}
              {" · "}
              {t("stats.waves.medianWave")}:{" "}
              {duration(summary.medianWaveDurationMs)}
            </li>
            {summary.meanRevisionsPerRoot !== null && (
              <li>
                {t("stats.waves.revisionsPerRoot", {
                  value: summary.meanRevisionsPerRoot.toFixed(2),
                })}
              </li>
            )}
            {summary.totalCostUsd === null && (
              <li>{t("stats.waves.costUnpriced")}</li>
            )}
            {summary.capped && window === null && (
              <li>
                {t("stats.waves.cappedNote", {
                  count: MAX_WAVE_TELEMETRY_RECORDS,
                })}
              </li>
            )}
          </ul>

          <h4 className="mt-4 text-xs font-semibold text-foreground">
            {t("stats.waves.daily")}
          </h4>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {summary.daily.map((point) => (
              <li key={point.day} className="flex items-baseline gap-2">
                <span className="tabular-nums">
                  {t("stats.waves.dailyRow", {
                    day: point.day,
                    waves: point.waves,
                    tokens: formatUsageTokens(point.tokens),
                  })}
                </span>
                {point.costUsd !== undefined && (
                  <span className="tabular-nums">
                    {formatUsageCost(point.costUsd, unavailable)}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {/* The measured facts the conductor is handed (P39). Shown here as
              well as in the prompt because a number that steers the work
              should be one the operator can check — and disagree with. */}
          {facts.steps.length > 0 || facts.conductors.length > 0 ? (
            <>
              <h4 className="mt-4 text-xs font-semibold text-foreground">
                {t("stats.waves.facts")}
              </h4>
              <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                {t("stats.waves.factsDescription", {
                  count: MIN_FACT_OBSERVATIONS,
                })}
              </p>
              <ul
                className="mt-1 space-y-0.5 text-xs text-muted-foreground"
                data-testid="wave-telemetry-facts"
              >
                {facts.steps.map((fact) => (
                  <li key={`${fact.role}:${fact.modelId}`}>
                    {t("stats.waves.factStep", {
                      model: fact.modelId,
                      role: fact.role,
                      completed: fact.completed,
                      runs: fact.runs,
                    })}
                  </li>
                ))}
                {facts.conductors.map((fact) => (
                  <li key={`conductor:${fact.modelId}`}>
                    {t("stats.waves.factConductor", {
                      model: fact.modelId,
                      accepted: fact.accepted,
                      waves: fact.waves,
                    })}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
