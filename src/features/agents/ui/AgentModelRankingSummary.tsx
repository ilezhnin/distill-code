/** Automatic selection and its saved fallback, without predicting an unknown task. */

import { useTranslation } from "react-i18next";

import { LearnedClassStatus } from "@/features/benchmarks/ui/LearnedClassStatus";
import type { Persona } from "@/shared/types/agents";

import { parseAgentRankingSource } from "../lib/agentModelRanking";
import {
  MODEL_PREFERENCE_CLASSES,
  applyClassOverride,
  modelPreferenceClassForPersona,
} from "../lib/modelRanking";
import { useRoutingPolicyStore } from "../stores/routingPolicyStore";

interface RankingRow {
  label: string;
  effort?: string;
  fast?: boolean;
}

export interface AgentModelRankingSummaryProps {
  persona: Pick<
    Persona,
    | "displayName"
    | "modelRanking"
    | "provider"
    | "model"
    | "effort"
    | "fastMode"
  >;
}

export function AgentModelRankingSummary({
  persona,
}: AgentModelRankingSummaryProps) {
  const { t } = useTranslation("agents");

  const source = parseAgentRankingSource(persona.modelRanking);
  const roleClassId = modelPreferenceClassForPersona(persona);
  const legacyModel = persona.model?.trim() || undefined;
  const classId = source?.kind === "class" ? source.classId : roleClassId;
  // Fallback order; this is not a prediction for a future task.
  const classOverride = useRoutingPolicyStore((state) =>
    classId ? state.policy.classOverrides[classId] : undefined,
  );

  let rows: RankingRow[] = [];
  let note: string | null = null;
  if (source?.kind === "list") {
    rows = source.ranking.entries.map((entry) => ({
      label: entry.label,
      effort: entry.effort,
      fast: entry.fastMode,
    }));
  } else if (classId) {
    rows = applyClassOverride(
      MODEL_PREFERENCE_CLASSES[classId].ranking,
      classOverride,
    ).map((candidate) => ({
      label: candidate.label,
      effort: candidate.effort,
    }));
    note = t(
      classOverride ? "ranking.viewFromRouting" : "ranking.viewFromRole",
    );
  } else if (legacyModel) {
    // No ranking anywhere, but a legacy single model exists: it IS the
    // preference, so it renders as the list's only row rather than the page
    // pretending no preference is set.
    rows = [
      { label: legacyModel, effort: persona.effort, fast: persona.fastMode },
    ];
    note = t("ranking.viewSingleModel");
  }

  // A role-ordered agent that also carries a legacy single model falls back
  // to that model when nothing ranked is usable — say so instead of letting
  // the old pair silently vanish from the page.
  const fallbackNote =
    classId && !source && legacyModel
      ? t("ranking.viewLegacyFallback", { model: legacyModel })
      : null;

  // A model may legally appear twice (same model, two efforts), so keys are
  // the label plus which occurrence of it a row is — same scheme as the
  // editable ranking field.
  const seen = new Map<string, number>();
  const keyedRows = rows.map((row) => {
    const occurrence = (seen.get(row.label) ?? 0) + 1;
    seen.set(row.label, occurrence);
    return { key: `${row.label}#${occurrence}`, row };
  });

  return (
    <div className="space-y-1.5" data-testid="agent-ranking-summary">
      <p>{t("ranking.automatic")}</p>
      <LearnedClassStatus classId={classId ?? "general"} />
      <details>
        <summary className="cursor-pointer">
          {t("ranking.fallbackTitle")}
        </summary>
        {rows.length === 0 ? (
          <p data-testid="agent-ranking-summary-none">
            {t("ranking.viewNone")}
          </p>
        ) : null}
        <ol className="list-none space-y-1">
          {keyedRows.map(({ key, row }, index) => (
            <li
              key={key}
              className="flex items-baseline gap-2"
              data-testid="agent-ranking-summary-row"
            >
              <span className="w-4 shrink-0 text-[11px] text-surface-agent-profile-fg-muted">
                {index + 1}
              </span>
              <span className="min-w-0 break-words">
                {row.label}
                {row.effort ? (
                  <span className="text-surface-agent-profile-fg-muted">
                    {" "}
                    · {row.effort}
                  </span>
                ) : null}
                {row.fast ? (
                  <span className="text-surface-agent-profile-fg-muted">
                    {" "}
                    · {t("ranking.fast")}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        {note ? (
          <p
            className="text-[11px] leading-4 text-surface-agent-profile-fg-muted"
            data-testid="agent-ranking-summary-note"
          >
            {note}
          </p>
        ) : null}
        {fallbackNote ? (
          <p
            className="text-[11px] leading-4 text-surface-agent-profile-fg-muted"
            data-testid="agent-ranking-summary-fallback"
          >
            {fallbackNote}
          </p>
        ) : null}
      </details>
    </div>
  );
}
