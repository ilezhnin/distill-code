/**
 * The agent's ranked model list, as an editable field.
 *
 * One model is a wish; a ranking is a policy. The operator asked to say, per
 * role, "first Opus 5 at extra-high, then Fable extra-high, then Sol, then
 * Grok" and have the conductor walk that against the live rate limits — so
 * this field edits the order, and shows what the order actually resolves to
 * right now, because a preference whose effect is invisible is a preference
 * nobody can trust (D5).
 *
 * The list is stored on the persona's `model_ranking` property; an agent that
 * has never been tuned shows the built-in class for its role as the starting
 * point rather than an empty box.
 */

import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowDown,
  IconArrowUp,
  IconPlus,
  IconX,
} from "@tabler/icons-react";

import { useAgentStore } from "@/features/agents/stores/agentStore";
import { useProviderModels } from "@/features/providers/hooks/useProviderModels";
import { useProviderRateLimitsStore } from "@/features/status/stores/providerRateLimitsStore";
import { platformLimitState } from "@/features/status/lib/rateLimitWindows";
import type { AgentPlatformId } from "@/features/status/lib/rateLimitTypes";
import type { EmbeddedReasoningEffort } from "@/features/chat/lib/modelReasoningVariants";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";

import {
  candidatesForRankingSource,
  MAX_AGENT_RANKING_ENTRIES,
  parseAgentRankingSource,
  rankingFromClass,
  serializeAgentModelRanking,
  type AgentModelRanking,
  type AgentRankingEntry,
} from "../../lib/agentModelRanking";
import {
  modelPreferenceClassForPersona,
  resolveRankedCandidates,
} from "../../lib/modelRanking";

/** Efforts worth offering. The full vocabulary is harness-specific noise. */
const EFFORT_CHOICES: readonly EmbeddedReasoningEffort[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

const NO_EFFORT = "__default__";

export interface ModelRankingFieldProps {
  /** Raw `model_ranking` property value. */
  value: string;
  /** Persisted as the property; `null` clears the ranking. */
  onChange: (next: string | null) => void;
  /** Agent name, used to find the built-in class for its role. */
  displayName?: string;
  /**
   * True when `value` is a display seed built from the agent's legacy single
   * provider/model pair rather than a stored ranking. Renders a note saying
   * so: the row only becomes the stored ranking when the operator edits the
   * list and saves (D5 — a migration the operator cannot see is a lie).
   */
  legacySeeded?: boolean;
  isReadOnly?: boolean;
  classes?: { fieldLabel?: string; selectTrigger?: string };
}

export function ModelRankingField({
  value,
  onChange,
  displayName,
  legacySeeded = false,
  isReadOnly = false,
  classes,
}: ModelRankingFieldProps) {
  const { t } = useTranslation(["agents", "common"]);
  const providers = useAgentStore((state) => state.providers);
  const { getModelsForAgent } = useProviderModels();
  const rateLimits = useProviderRateLimitsStore(
    (state) => state.snapshot?.providers,
  );

  const source = useMemo(() => parseAgentRankingSource(value), [value]);
  const entries = useMemo<AgentRankingEntry[]>(
    () => (source?.kind === "list" ? source.ranking.entries : []),
    [source],
  );
  // The rows reorder, so their keys cannot be positions. A model may legally
  // appear twice (same model, two efforts), so the key is the model plus which
  // occurrence of it this row is.
  const keyedEntries = useMemo(() => {
    const seen = new Map<string, number>();
    return entries.map((entry) => {
      const id = `${entry.platform}:${entry.modelId}`;
      const occurrence = (seen.get(id) ?? 0) + 1;
      seen.set(id, occurrence);
      return { key: `${id}#${occurrence}`, entry };
    });
  }, [entries]);

  /** Every installed model, flattened, as the row pickers see it. */
  const inventory = useMemo(
    () =>
      providers.flatMap((provider) =>
        getModelsForAgent(provider.id).map((model) => ({
          platform: provider.id as AgentPlatformId,
          providerLabel: provider.label,
          modelId: model.id,
          label: model.displayName ?? model.name ?? model.id,
        })),
      ),
    [getModelsForAgent, providers],
  );

  const classId = useMemo(
    () => modelPreferenceClassForPersona({ displayName }),
    [displayName],
  );

  const commit = useCallback(
    (next: AgentRankingEntry[]) => {
      if (next.length === 0) {
        onChange(null);
        return;
      }
      const ranking: AgentModelRanking = { version: 1, entries: next };
      onChange(serializeAgentModelRanking(ranking));
    },
    [onChange],
  );

  const addEntry = useCallback(() => {
    const used = new Set(entries.map((entry) => entry.modelId));
    const candidate =
      inventory.find((model) => !used.has(model.modelId)) ?? inventory[0];
    if (!candidate) return;
    commit([
      ...entries,
      {
        platform: candidate.platform,
        modelId: candidate.modelId,
        label: candidate.label,
      },
    ]);
  }, [commit, entries, inventory]);

  const fillFromRole = useCallback(() => {
    if (!classId) return;
    const built = rankingFromClass(classId, inventory);
    if (built.entries.length === 0) return;
    commit(built.entries);
  }, [classId, commit, inventory]);

  const move = useCallback(
    (index: number, delta: number) => {
      const target = index + delta;
      if (target < 0 || target >= entries.length) return;
      const next = [...entries];
      [next[index], next[target]] = [next[target], next[index]];
      commit(next);
    },
    [commit, entries],
  );

  const remove = useCallback(
    (index: number) => commit(entries.filter((_, at) => at !== index)),
    [commit, entries],
  );

  const setModel = useCallback(
    (index: number, modelKey: string) => {
      const picked = inventory.find(
        (model) => `${model.platform}:${model.modelId}` === modelKey,
      );
      if (!picked) return;
      const next = [...entries];
      next[index] = {
        ...next[index],
        platform: picked.platform,
        modelId: picked.modelId,
        label: picked.label,
      };
      commit(next);
    },
    [commit, entries, inventory],
  );

  const setEffort = useCallback(
    (index: number, effort: string) => {
      const next = [...entries];
      const { effort: _dropped, ...rest } = next[index];
      next[index] =
        effort === NO_EFFORT
          ? rest
          : { ...rest, effort: effort as EmbeddedReasoningEffort };
      commit(next);
    },
    [commit, entries],
  );

  /**
   * What this ranking resolves to right now — the same resolution the session
   * path runs, against the same live limits.
   */
  const preview = useMemo(() => {
    if (!source) return undefined;
    const limits = rateLimits ?? [];
    const installed = new Set(providers.map((provider) => provider.id));
    return resolveRankedCandidates(candidatesForRankingSource(source), {
      modelsForPlatform: (platform) =>
        installed.has(platform) ? getModelsForAgent(platform) : [],
      allModels: () =>
        providers.flatMap((provider) =>
          getModelsForAgent(provider.id).map((model) => ({
            harnessId: provider.id,
            model,
          })),
        ),
      platformLimitState: (platform, scopedWindow) =>
        platformLimitState(limits, platform, { scopedWindow }),
    });
  }, [getModelsForAgent, providers, rateLimits, source]);

  return (
    <div className="flex flex-col gap-2" data-testid="model-ranking-field">
      <Label className={classes?.fieldLabel}>{t("ranking.label")}</Label>

      {/* The empty state is still a list — just one with no rows yet. The add
          control renders below in both states, so starting a ranking never
          requires discovering that a text placeholder hides the entry point. */}
      {entries.length > 0 ? (
        <ol className="flex list-none flex-col gap-1.5">
          {keyedEntries.map(({ key, entry }, index) => (
            <li
              key={key}
              className="flex items-center gap-1.5"
              data-testid="model-ranking-row"
            >
              <span className="w-4 shrink-0 text-[11px] text-muted-foreground">
                {index + 1}
              </span>
              <Select
                value={`${entry.platform}:${entry.modelId}`}
                onValueChange={(next) => setModel(index, next)}
                disabled={isReadOnly}
              >
                <SelectTrigger
                  className={cn("min-w-0 flex-1", classes?.selectTrigger)}
                  aria-label={t("ranking.modelAria", { position: index + 1 })}
                >
                  <SelectValue placeholder={entry.label} />
                </SelectTrigger>
                <SelectContent>
                  {inventory.map((model) => (
                    <SelectItem
                      key={`${model.platform}:${model.modelId}`}
                      value={`${model.platform}:${model.modelId}`}
                    >
                      {model.providerLabel} · {model.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={entry.effort ?? NO_EFFORT}
                onValueChange={(next) => setEffort(index, next)}
                disabled={isReadOnly}
              >
                <SelectTrigger
                  className={cn("w-24 shrink-0", classes?.selectTrigger)}
                  aria-label={t("ranking.effortAria", { position: index + 1 })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_EFFORT}>
                    {t("ranking.effortDefault")}
                  </SelectItem>
                  {EFFORT_CHOICES.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {effort}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={isReadOnly || index === 0}
                onClick={() => move(index, -1)}
                tooltip={t("ranking.moveUp")}
                aria-label={t("ranking.moveUp")}
              >
                <IconArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={isReadOnly || index === entries.length - 1}
                onClick={() => move(index, 1)}
                tooltip={t("ranking.moveDown")}
                aria-label={t("ranking.moveDown")}
              >
                <IconArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                destructive
                disabled={isReadOnly}
                onClick={() => remove(index)}
                tooltip={t("ranking.remove")}
                aria-label={t("ranking.remove")}
              >
                <IconX />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}

      {entries.length < MAX_AGENT_RANKING_ENTRIES ? (
        <Button
          type="button"
          variant="ghost"
          size="xxs"
          flush
          disabled={isReadOnly || inventory.length === 0}
          onClick={addEntry}
          leftIcon={<IconPlus />}
          data-testid="model-ranking-add"
        >
          {t("ranking.add")}
        </Button>
      ) : null}

      {legacySeeded && entries.length > 0 ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="model-ranking-legacy-note"
        >
          {t("ranking.legacySeeded")}
        </p>
      ) : null}

      {entries.length === 0 ? (
        // Secondary helper under the empty list: what an empty ranking means,
        // and the role shortcut for agents whose role has a built-in order.
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="model-ranking-empty"
        >
          {t("ranking.empty")}
          {classId ? (
            <>
              {" "}
              <Button
                type="button"
                variant="ghost"
                size="xxs"
                flush
                disabled={isReadOnly || inventory.length === 0}
                onClick={fillFromRole}
                data-testid="model-ranking-fill"
              >
                {t("ranking.fillFromRole")}
              </Button>
            </>
          ) : null}
        </p>
      ) : null}

      {preview ? (
        <p
          className="text-[11px] text-muted-foreground"
          data-testid="model-ranking-preview"
        >
          {preview.choice
            ? t("ranking.previewPick", {
                model: preview.choice.label,
                effort: preview.choice.effort ?? t("ranking.effortDefault"),
              })
            : t("ranking.previewNone")}
          {preview.skipped.length > 0
            ? ` — ${preview.skipped
                .map((skip) =>
                  t(`ranking.skip.${skip.reason}`, { model: skip.label }),
                )
                .join("; ")}`
            : ""}
        </p>
      ) : null}
    </div>
  );
}
