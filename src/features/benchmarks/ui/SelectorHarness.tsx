import { Fragment, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TOOLTIP_DELAY } from "@/shared/ui/tooltip-delay";
import { benchmarkApi } from "../api/benchmarks";
import { benchmarkKeys } from "../hooks/useBenchmarks";
import { workClassLabel } from "../lib/benchmarkLabels";
import { personaPrior, rewardPoints } from "../lib/benchmarkSelector";
import type { SelectorHarnessReport } from "../types";
import { BenchmarkEmpty, SectionHeading } from "./BenchmarkPrimitives";

const POLICIES = ["selector", "best_fixed", "persona", "oracle"] as const;

/**
 * The held-out harness of every class with a measured case: the selector's
 * mean reward against the best single configuration, the persona's ranking
 * and the per-case oracle, and the selector gain that decides whether the
 * selector may choose models anywhere.
 */
export function SelectorHarness() {
  const { t } = useTranslation(["benchmarks", "settings"]);
  const query = useMemo(
    () => ({ runId: null, versionIds: null, offset: 0, limit: 500 }),
    [],
  );
  const leaderboard = useQuery({
    queryKey: [...benchmarkKeys, "leaderboard", query],
    queryFn: () => benchmarkApi.getLeaderboard(query),
  });
  const configurations = useMemo(
    () =>
      (leaderboard.data?.rows ?? [])
        .filter((row) => row.status !== "excluded")
        .map((row) => row.configuration),
    [leaderboard.data],
  );
  const classes = leaderboard.data?.cohort?.workClasses ?? [];
  const reports = useQuery({
    queryKey: [...benchmarkKeys, "selector-harness", classes, configurations],
    enabled: classes.length > 0 && configurations.length > 0,
    queryFn: async () =>
      (
        await Promise.all(
          classes.map((workClassId) =>
            benchmarkApi.selectorHarness({
              workClassId,
              candidates: configurations.map((configuration) => ({
                configuration,
                available: true,
                reason: null,
              })),
              prior: personaPrior(workClassId, configurations),
            }),
          ),
        )
      ).filter((report) => report.cases > 0),
  });
  const head = (label: string, hint: string) => (
    <TableHead className="text-right">
      <Tooltip delayDuration={TOOLTIP_DELAY.held}>
        <TooltipTrigger asChild>
          <span>{label}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          {hint}
        </TooltipContent>
      </Tooltip>
    </TableHead>
  );
  const points = (report: SelectorHarnessReport, policy: string) => {
    const result = report.policies.find((entry) => entry.policy === policy);
    return result ? String(rewardPoints(result.meanReward)) : "-";
  };
  return (
    <section className="space-y-3">
      <SectionHeading title={t("benchmarks:selector.title")} />
      {reports.isPending && classes.length > 0 && configurations.length > 0 ? (
        <BenchmarkEmpty title={t("benchmarks:loading")} compact />
      ) : (reports.data ?? []).length === 0 ? (
        <BenchmarkEmpty title={t("benchmarks:selector.empty")} compact />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("benchmarks:fields.workClass")}</TableHead>
              {head(
                t("benchmarks:selector.cases"),
                t("benchmarks:selector.casesHint"),
              )}
              {POLICIES.map((policy) => (
                <Fragment key={policy}>
                  {head(
                    t(`benchmarks:selector.policies.${policy}`),
                    t(`benchmarks:selector.hints.${policy}`),
                  )}
                </Fragment>
              ))}
              {head(
                t("benchmarks:selector.gain"),
                t("benchmarks:selector.gainHint"),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(reports.data ?? []).map((report) => {
              const gain =
                report.selectorGain == null
                  ? null
                  : rewardPoints(report.selectorGain);
              return (
                <TableRow key={report.workClassId}>
                  <TableCell>{workClassLabel(t, report.workClassId)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {report.cases}
                  </TableCell>
                  {POLICIES.map((policy) => (
                    <TableCell key={policy} className="text-right tabular-nums">
                      {points(report, policy)}
                    </TableCell>
                  ))}
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      gain != null && gain > 0 && "text-success",
                      gain != null && gain < 0 && "text-destructive",
                    )}
                  >
                    {gain == null ? "-" : gain > 0 ? `+${gain}` : String(gain)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
