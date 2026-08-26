import type { AgentSpawnLayer } from "@/shared/types/agents";

/**
 * Canonical order of the spawn layers. Every parsed `spawns` list is
 * normalized to this order so two authors writing the same permission in a
 * different order produce byte-identical prompts and notices.
 */
export const AGENT_SPAWN_LAYERS: readonly AgentSpawnLayer[] = [
  "conductor",
  "orchestrator",
  "worker",
];

function isSpawnLayer(value: unknown): value is AgentSpawnLayer {
  return (
    typeof value === "string" &&
    (AGENT_SPAWN_LAYERS as readonly string[]).includes(value)
  );
}

/**
 * Parses a persona-frontmatter `spawns` value into a validated layer list.
 *
 * Accepted shapes, matching how YAML authors actually write lists:
 * - an array of layer names — `spawns: [worker]`
 * - a single layer name — `spawns: worker`
 * - an empty array — a real override meaning "may spawn nothing"
 *
 * Anything else — a non-string entry, an unknown layer name, an object —
 * invalidates the WHOLE value and returns `undefined`, so the persona falls
 * back to its layer's default permissions. Half-honouring a garbled ACL
 * (keeping the entries that happened to parse) would grant or withhold spawn
 * rights the author never wrote; ignoring it keeps the persona on the same
 * defaults it had before the field existed.
 *
 * Names are trimmed and lowercased; duplicates collapse; the result is in
 * {@link AGENT_SPAWN_LAYERS} order.
 */
export function parseSpawnLayers(
  value: unknown,
): AgentSpawnLayer[] | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const normalized = entries.map((entry) =>
    typeof entry === "string" ? entry.trim().toLowerCase() : entry,
  );
  if (!normalized.every(isSpawnLayer)) {
    return undefined;
  }
  const unique = new Set(normalized);
  return AGENT_SPAWN_LAYERS.filter((layer) => unique.has(layer));
}
