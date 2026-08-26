/**
 * Operator-facing copy for a persona's two ACL fields.
 *
 * Both fields have the same awkward shape: what an agent falls back to when
 * it carries no override is a property of the LAYER the session runs on, not
 * of the agent — the same persona is a conductor in one session and a worker
 * in the next. The editor and the profile page therefore never claim to know
 * an agent's one true default; they state the whole table, generated from
 * `aclDefaults` so the sentence cannot drift from the rule.
 *
 * The lists are built here rather than written out in the locale files for
 * the same reason: a default that changes in code changes the sentence too.
 */

import type { TFunction } from "i18next";

import {
  ACL_ROLE_ORDER,
  DEFAULT_SPAWNS_BY_ROLE,
} from "@/features/conductor/aclDefaults";
import { AGENT_SPAWN_LAYERS } from "@/shared/lib/agentSpawns";
import type { AgentSpawnLayer } from "@/shared/types/agents";

type AgentsTranslate = TFunction<"agents">;

/**
 * The layers the editor offers as toggles.
 *
 * `conductor` is not one of them: no layer's default includes it, and an
 * agent that may start conductors is a thing to write by hand and mean. It
 * still renders when a persona already carries it (see
 * {@link spawnLayerChoices}) — the editor must never quietly drop a
 * permission it declines to offer.
 */
export const EDITABLE_SPAWN_LAYERS: readonly AgentSpawnLayer[] = [
  "orchestrator",
  "worker",
];

/** The toggles to render for a given stored override, in canonical order. */
export function spawnLayerChoices(
  value: readonly AgentSpawnLayer[] | undefined,
): AgentSpawnLayer[] {
  return AGENT_SPAWN_LAYERS.filter(
    (layer) => EDITABLE_SPAWN_LAYERS.includes(layer) || value?.includes(layer),
  );
}

/** Layer names as they read inside a sentence: "orchestrators, workers". */
export function formatSpawnLayerList(
  t: AgentsTranslate,
  layers: readonly AgentSpawnLayer[],
): string {
  if (layers.length === 0) {
    return t("acl.nothing");
  }
  return layers.map((layer) => t(`acl.layerInline.${layer}`)).join(", ");
}

/** Every layer's spawn default, in one line. */
export function formatSpawnDefaults(t: AgentsTranslate): string {
  return ACL_ROLE_ORDER.map((role) =>
    t("acl.defaultsEntry", {
      role: t(`acl.role.${role}`),
      value: formatSpawnLayerList(t, DEFAULT_SPAWNS_BY_ROLE[role]),
    }),
  ).join(" · ");
}
