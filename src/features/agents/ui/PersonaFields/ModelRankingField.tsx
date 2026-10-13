/** Optional saved fallback preferences; automatic task selection owns dispatch. */

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
import { providerModelInventoryMessage } from "@/features/providers/lib/providerModelInventoryStatus";
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
import { Switch } from "@/shared/ui/switch";

import {
  isAgentRankingPlatform,
  MAX_AGENT_RANKING_ENTRIES,
  parseAgentRankingSource,
  rankingEffortChoices,
  rankingInventoryFromProviders,
  serializeAgentModelRanking,
  type AgentModelRanking,
  type AgentRankingEntry,
} from "../../lib/agentModelRanking";
const NO_EFFORT = "__default__";

export interface ModelRankingFieldProps {
  /** Raw `model_ranking` property value. */
  value: string;
  /** Persisted as the property; `null` clears the ranking. */
  onChange: (next: string | null) => void;
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
  legacySeeded = false,
  isReadOnly = false,
  classes,
}: ModelRankingFieldProps) {
  const { t } = useTranslation(["agents", "common"]);
  const providers = useAgentStore((state) => state.providers);
  const { getModelsForAgent, getModelInventoryProblem } = useProviderModels();
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

  /**
   * Models the picker may write. Goose is first in the catalog and holds the
   * combined list; its harness id cannot be stored, so each model is mapped
   * onto a metered platform or omitted.
   */
  const inventory = useMemo(
    () => rankingInventoryFromProviders(providers, getModelsForAgent),
    [getModelsForAgent, providers],
  );

  /**
   * Why there is nothing to rank, when there is nothing to rank. An empty
   * inventory can mean a provider poll that failed, a provider that answered
   * with no models, or genuinely nothing installed — and the field rendered
   * all three as the same disabled "Add model" button.
   */
  const inventoryStatus = useMemo(() => {
    if (inventory.length > 0) {
      return null;
    }
    for (const provider of providers) {
      if (!isAgentRankingPlatform(provider.id)) continue;
      const problem = getModelInventoryProblem(provider.id);
      if (problem) {
        return providerModelInventoryMessage(problem);
      }
    }
    return null;
  }, [getModelInventoryProblem, inventory.length, providers]);

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
      next[index] = effort === NO_EFFORT ? rest : { ...rest, effort };
      commit(next);
    },
    [commit, entries],
  );

  // Off is "not stated" rather than a stored `false`, so turning the switch
  // off leaves the entry exactly as it was before fast mode was ever set.
  const setFast = useCallback(
    (index: number, fast: boolean) => {
      const next = [...entries];
      const { fastMode: _dropped, ...rest } = next[index];
      next[index] = fast ? { ...rest, fastMode: true } : rest;
      commit(next);
    },
    [commit, entries],
  );

  const inventoryItemFor = useCallback(
    (entry: AgentRankingEntry) =>
      inventory.find(
        (model) =>
          model.platform === entry.platform && model.modelId === entry.modelId,
      ),
    [inventory],
  );

  return (
    <div className="flex flex-col gap-2" data-testid="model-ranking-field">
      <Label className={classes?.fieldLabel}>{t("ranking.label")}</Label>
      <p className="text-xs text-muted-foreground">{t("ranking.automatic")}</p>
      <details>
        <summary className="cursor-pointer text-sm">
          {t("ranking.fallbackTitle")}
        </summary>
        <p className="text-xs text-muted-foreground">
          {t("ranking.fallbackDescription")}
        </p>

        {/* The empty state is still a list — just one with no rows yet. The add
          control renders below in both states, so starting a ranking never
          requires discovering that a text placeholder hides the entry point. */}
        {entries.length > 0 ? (
          <ol className="flex list-none flex-col gap-1.5">
            {keyedEntries.map(({ key, entry }, index) => {
              const inventoryItem = inventoryItemFor(entry);
              const effortChoices = rankingEffortChoices(entry, inventoryItem);
              // The switch follows the model: shown where the model has fast
              // mode, and kept where the entry already asks for it so a stored
              // value never becomes invisible.
              const showFast =
                inventoryItem?.supportsFast === true || entry.fastMode === true;
              return (
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
                      aria-label={t("ranking.modelAria", {
                        position: index + 1,
                      })}
                    >
                      {/* The stored label renders as the value text directly: a
                      Radix placeholder only shows for an empty value, so a row
                      whose model id no longer matches the installed inventory
                      (a renamed model, or the legacy single-model seed for a
                      model that is not installed) would otherwise show a blank
                      select — exactly the silent drift the stored label exists
                      to survive. */}
                      <SelectValue placeholder={entry.label}>
                        {entry.label}
                      </SelectValue>
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
                    value={
                      effortChoices.find(
                        (choice) =>
                          choice.id.toLowerCase() ===
                          entry.effort?.toLowerCase(),
                      )?.id ?? NO_EFFORT
                    }
                    onValueChange={(next) => setEffort(index, next)}
                    disabled={isReadOnly || effortChoices.length === 0}
                  >
                    <SelectTrigger
                      className={cn("w-24 shrink-0", classes?.selectTrigger)}
                      aria-label={t("ranking.effortAria", {
                        position: index + 1,
                      })}
                      data-testid="model-ranking-effort"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_EFFORT}>
                        {t("ranking.effortDefault")}
                      </SelectItem>
                      {effortChoices.map((choice) => (
                        <SelectItem key={choice.id} value={choice.id}>
                          {choice.unlisted
                            ? t("ranking.effortNotOffered", {
                                effort: choice.name,
                              })
                            : choice.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {showFast ? (
                    <Switch
                      checked={entry.fastMode === true}
                      onCheckedChange={(checked) => setFast(index, checked)}
                      disabled={isReadOnly}
                      aria-label={t("ranking.fastAria", {
                        position: index + 1,
                      })}
                      data-testid="model-ranking-fast"
                    />
                  ) : null}
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
              );
            })}
          </ol>
        ) : null}

        {entries.length < MAX_AGENT_RANKING_ENTRIES ? (
          <Button
            type="button"
            variant="ghost"
            size="xxs"
            disabled={isReadOnly || inventory.length === 0}
            onClick={addEntry}
            leftIcon={<IconPlus />}
            data-testid="model-ranking-add"
          >
            {t("ranking.add")}
          </Button>
        ) : null}

        {inventoryStatus ? (
          // Sits under the disabled add control and says why it is disabled.
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="model-ranking-inventory-status"
          >
            {t(inventoryStatus.key, inventoryStatus.values)}
          </p>
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
          // Clearing a custom list restores the existing role/default fallback.
          <p
            className="text-[11px] text-muted-foreground"
            data-testid="model-ranking-empty"
          >
            {t("ranking.empty")}
          </p>
        ) : null}
      </details>
    </div>
  );
}
