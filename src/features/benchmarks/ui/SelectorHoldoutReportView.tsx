import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import { benchmarkApi, benchmarkErrorMessage } from "../api/benchmarks";
import { configurationLabel } from "../lib/benchmarkDraft";
import type { SelectorHoldoutPlan } from "../lib/benchmarkLearning";
import { BenchmarkAlert } from "./BenchmarkPrimitives";

export function SelectorHoldoutReportView({
  plan,
}: {
  plan: SelectorHoldoutPlan;
}) {
  const { t } = useTranslation("benchmarks");
  const client = useQueryClient();
  const queryKey = ["benchmarks", "selector-holdout-report", plan.id];
  const query = useQuery({
    queryKey,
    queryFn: () => benchmarkApi.getSelectorHoldoutReport(plan.id),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const report = query.data;
  const evaluate = async () => {
    setBusy(true);
    setError(null);
    try {
      client.setQueryData(
        queryKey,
        await benchmarkApi.evaluateSelectorHoldout(plan.id),
      );
    } catch (failure) {
      setError(benchmarkErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const candidate = (key: string) => {
    const configuration = plan.configurations.find((c) => c.id === key);
    return configuration ? configurationLabel(configuration) : key;
  };
  const policy = (name: string) => {
    if (name.startsWith("fixed:")) return candidate(name.slice(6));
    switch (name) {
      case "learned":
        return t("learning.report.learned");
      case "aggregate":
        return t("learning.report.aggregate");
      case "persona":
        return t("learning.report.persona");
      case "best_fixed":
        return t("learning.report.bestFixed");
      case "oracle":
        return t("learning.report.oracle");
      default:
        return name;
    }
  };
  const fraction = (value: number) => value.toFixed(3);
  return (
    <section className="mt-3 space-y-3 border-t pt-3">
      <h4 className="font-medium">{t("learning.report.title")}</h4>
      <p className="text-xs text-muted-foreground">
        {t("learning.report.description")}
      </p>
      {error || query.error ? (
        <BenchmarkAlert>
          {error ?? benchmarkErrorMessage(query.error)}
        </BenchmarkAlert>
      ) : null}
      {!report ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t(
              plan.evaluation
                ? "learning.report.freezeNotice"
                : "learning.report.legacy",
            )}
          </p>
          <Button
            type="button"
            disabled={busy || query.isPending || !plan.evaluation}
            onClick={() => void evaluate()}
          >
            {t("learning.report.evaluate")}
          </Button>
        </>
      ) : (
        <>
          <p className="text-xs">
            {t("learning.report.coverage", {
              groups: report.groups,
              fallbacks: report.fallbackCases,
            })}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  {[
                    "policy",
                    "quality",
                    "utility",
                    "duration",
                    "cost",
                    "gain",
                  ].map((column) => (
                    <th key={column} className="p-2 font-medium">
                      {t(`learning.report.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.policies.map((row) => (
                  <tr key={row.policy} className="border-t">
                    <th scope="row" className="p-2 font-normal">
                      {policy(row.policy)}
                      {row.selectedFixedKey ? (
                        <span className="block text-muted-foreground">
                          {candidate(row.selectedFixedKey)}
                        </span>
                      ) : null}
                    </th>
                    <td className="p-2">{fraction(row.quality)}</td>
                    <td className="p-2">
                      {fraction(row.utility)}
                      <span className="block text-muted-foreground">
                        [{fraction(row.utilityInterval.lower)},{" "}
                        {fraction(row.utilityInterval.upper)}]
                      </span>
                    </td>
                    <td className="p-2">
                      {row.meanDurationMs === null
                        ? t("learning.report.unknown", {
                            count: row.missingDurationCases,
                          })
                        : `${(row.meanDurationMs / 1000).toFixed(2)} s`}
                    </td>
                    <td className="p-2">
                      {row.meanCost === null
                        ? t("learning.report.unknown", {
                            count: row.missingCostCases,
                          })
                        : `$${row.meanCost.toFixed(4)}`}
                    </td>
                    <td className="p-2">
                      {fraction(row.learnedUtilityGain)}
                      <span className="block text-muted-foreground">
                        [{fraction(row.learnedGainInterval.lower)},{" "}
                        {fraction(row.learnedGainInterval.upper)}]
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("learning.report.intervals")}
          </p>
          <details>
            <summary className="cursor-pointer text-xs">
              {t("learning.report.evidence")}
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
              {JSON.stringify(report, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
