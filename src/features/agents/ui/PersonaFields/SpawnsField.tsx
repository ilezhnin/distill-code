/**
 * Which conductor-graph layers this agent may start, as an editable field.
 *
 * The `spawns` ACL has three states and the field has to keep them apart,
 * because two of them look the same in a checkbox row and mean opposite
 * things:
 *
 * - NOT SET (no key, or `spawns: null`) — the agent runs on whatever its
 *   layer allows. Every box is clear because nothing was chosen, not because
 *   the operator forbade anything.
 * - SET TO NOTHING (`spawns: []`) — a real override: this agent starts
 *   nothing, whatever layer it runs on.
 * - SET TO A LIST — starts exactly those layers.
 *
 * So unchecking the last box lands on "set to nothing" (the operator just
 * said so, box by box) and only Clear override returns to "not set". The
 * boxes render straight away, with the explanation as secondary text under
 * them: a permission whose control is hidden behind a paragraph is a
 * permission nobody finds.
 */

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { AGENT_SPAWN_LAYERS } from "@/shared/lib/agentSpawns";
import type { AgentSpawnLayer } from "@/shared/types/agents";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Label } from "@/shared/ui/label";

import {
  formatSpawnDefaults,
  formatSpawnLayerList,
  spawnLayerChoices,
} from "../../lib/personaAclCopy";

export interface SpawnsFieldProps {
  /** The validated override; `undefined` means no override is stored. */
  value: AgentSpawnLayer[] | undefined;
  /**
   * Persisted as the `spawns` property. `null` clears the override; an
   * array — the empty one included — is a real, stored permission.
   */
  onChange: (next: AgentSpawnLayer[] | null) => void;
  isReadOnly?: boolean;
  classes?: { fieldLabel?: string };
}

export function SpawnsField({
  value,
  onChange,
  isReadOnly = false,
  classes,
}: SpawnsFieldProps) {
  const { t } = useTranslation("agents");
  const choices = spawnLayerChoices(value);
  const isSet = value !== undefined;

  const toggleLayer = useCallback(
    (layer: AgentSpawnLayer, checked: boolean) => {
      const current = value ?? [];
      // Rebuilt from the canonical layer order, so the stored list is the
      // same whichever order the operator clicked the boxes in.
      onChange(
        AGENT_SPAWN_LAYERS.filter((candidate) =>
          candidate === layer ? checked : current.includes(candidate),
        ),
      );
    },
    [onChange, value],
  );

  const stateText =
    value === undefined
      ? t("acl.spawns.notSet", { defaults: formatSpawnDefaults(t) })
      : value.length === 0
        ? t("acl.spawns.overrideNothing")
        : t("acl.spawns.overrideList", {
            layers: formatSpawnLayerList(t, value),
          });

  return (
    <div className="flex flex-col gap-2" data-testid="agent-spawns-field">
      <Label className={classes?.fieldLabel}>{t("acl.spawns.label")}</Label>

      <fieldset
        aria-label={t("acl.spawns.groupAria")}
        className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2"
      >
        {choices.map((layer) => (
          <span key={layer} className="flex items-center gap-2">
            <Checkbox
              id={`agent-spawns-${layer}`}
              checked={value?.includes(layer) === true}
              disabled={isReadOnly}
              onCheckedChange={(checked) =>
                toggleLayer(layer, checked === true)
              }
              data-testid={`agent-spawns-toggle-${layer}`}
            />
            <label htmlFor={`agent-spawns-${layer}`} className="text-sm">
              {t(`acl.layer.${layer}`)}
            </label>
          </span>
        ))}

        {/* One slot, two jobs, because the state decides which move is even
            possible: from "not set" the only thing the boxes cannot express
            is the deliberate empty override, and from a stored override the
            only thing they cannot express is going back to unset. */}
        {isSet ? (
          <Button
            type="button"
            variant="ghost"
            size="xxs"
            flush
            disabled={isReadOnly}
            onClick={() => onChange(null)}
            data-testid="agent-spawns-clear"
          >
            {t("acl.spawns.clearOverride")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xxs"
            flush
            disabled={isReadOnly}
            onClick={() => onChange([])}
            data-testid="agent-spawns-set-nothing"
          >
            {t("acl.spawns.setNothing")}
          </Button>
        )}
      </fieldset>

      <p
        className="text-[11px] text-muted-foreground"
        data-testid="agent-spawns-state"
      >
        {stateText}
      </p>
    </div>
  );
}
