/**
 * Read-only view of the model preference an agent actually runs with, for the
 * agent detail page.
 *
 * Mirrors the runtime precedence in `rankedPersonaTarget.ts` instead of just
 * echoing stored fields, because the detail page's old Provider/Model block
 * lied by omission: it showed the legacy single model even when a ranking (or
 * the role's built-in order) would pick something else. Order shown here:
 * the agent's own ranking, else its role's built-in order, else the legacy
 * single model — with a note naming where the list came from (D5: what the
 * app will do must be visible, not inferred).
 */

import { useTranslation } from "react-i18next";

import type { Persona } from "@/shared/types/agents";

import { parseAgentRankingSource } from "../lib/agentModelRanking";
import {
  MODEL_PREFERENCE_CLASSES,
  modelPreferenceClassForPersona,
} from "../lib/modelRanking";

interface RankingRow {
  label: string;
  effort?: string;
}

export interface AgentModelRankingSummaryProps {
  persona: Pick<Persona, "displayName" | "modelRanking" | "provider" | "model">;
}

export function AgentModelRankingSummary({
  persona,
}: AgentModelRankingSummaryProps) {
  const { t } = useTranslation("agents");

  const source = parseAgentRankingSource(persona.modelRanking);
  const roleClassId = source
    ? undefined
    : modelPreferenceClassForPersona(persona);
  const legacyModel = persona.model?.trim() || undefined;

  let rows: RankingRow[] = [];
  let note: string | null = null;
  if (source?.kind === "list") {
    rows = source.ranking.entries.map((entry) => ({
      label: entry.label,
      effort: entry.effort,
    }));
  } else if (source?.kind === "class" || roleClassId) {
    const classId = source?.kind === "class" ? source.classId : roleClassId;
    if (classId) {
      rows = MODEL_PREFERENCE_CLASSES[classId].ranking.map((candidate) => ({
        label: candidate.label,
        effort: candidate.effort,
      }));
    }
    note = t("ranking.viewFromRole");
  } else if (legacyModel) {
    // No ranking anywhere, but a legacy single model exists: it IS the
    // preference, so it renders as the list's only row rather than the page
    // pretending no preference is set.
    rows = [{ label: legacyModel }];
    note = t("ranking.viewSingleModel");
  }

  if (rows.length === 0) {
    return (
      <p data-testid="agent-ranking-summary-none">{t("ranking.viewNone")}</p>
    );
  }

  // A role-ordered agent that also carries a legacy single model falls back
  // to that model when nothing ranked is usable — say so instead of letting
  // the old pair silently vanish from the page.
  const fallbackNote =
    note === t("ranking.viewFromRole") && legacyModel
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
    </div>
  );
}
