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

/**
 * Normalizes one agent reference for name matching: trimmed, lowercased,
 * spaces and underscores collapsed to hyphens. "Asset Integrator",
 * "asset_integrator" and "asset-integrator" all name the same agent.
 */
export function normalizeAgentRef(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/**
 * Parses a persona-frontmatter `spawns_agents` value into a validated list
 * of agent references.
 *
 * Same acceptance rules and the same all-or-nothing policy as
 * {@link parseSpawnLayers}: an array of names, a single name, or an empty
 * array (a real override — "may start no agents by name"); any non-string
 * or empty entry invalidates the whole value so a garbled list can never be
 * half-honoured. Entries are normalized and de-duplicated, preserving the
 * author's order — the order is the menu order callers see.
 */
export function parseSpawnAgents(value: unknown): string[] | undefined {
  const entries = Array.isArray(value) ? value : [value];
  const normalized: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string") return undefined;
    const ref = normalizeAgentRef(entry);
    if (!ref) return undefined;
    if (!normalized.includes(ref)) normalized.push(ref);
  }
  return normalized;
}

/**
 * Every normalized name a persona answers to: the file stem of its id, its
 * display name, and — for bundled agents whose display name drifted from
 * the file stem — the `berdBundledSource` metadata key. An allowlist entry
 * matches a persona when it matches any of these, so authors can write the
 * name they see in the UI or the name on disk and mean the same agent.
 */
export function personaAgentRefs(persona: {
  id: string;
  displayName: string;
  sourceProperties?: Record<string, unknown>;
}): string[] {
  const refs = new Set<string>();
  const stem = persona.id
    .replace(/\\/g, "/")
    .split("/")
    .at(-1)
    ?.replace(/\.persona\.md$/i, "")
    .replace(/\.md$/i, "");
  if (stem) refs.add(normalizeAgentRef(stem));
  if (persona.displayName) refs.add(normalizeAgentRef(persona.displayName));
  const metadata = persona.sourceProperties?.metadata;
  const bundledSource =
    metadata && typeof metadata === "object"
      ? (metadata as Record<string, unknown>).berdBundledSource
      : undefined;
  if (typeof bundledSource === "string" && bundledSource.trim()) {
    refs.add(normalizeAgentRef(bundledSource));
  }
  return [...refs];
}
