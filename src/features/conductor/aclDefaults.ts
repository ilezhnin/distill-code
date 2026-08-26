/**
 * What each conductor-graph layer may do when no persona says otherwise.
 *
 * The two ACL modules that enforce these defaults — `spawnAcl.ts` and the
 * memory feature's `memoryWriteAccess.ts` — both reach the conductor graph
 * store, and that store pulls the wave engine and the usage ledger in behind
 * it. The agent editor and the agent profile page do not enforce anything;
 * they only need to SAY what a layer's default is, so the tables live here,
 * in a module whose only imports are types. Importing a permission label
 * must not wake the graph.
 *
 * These tables stay the single owner of the defaults: `spawnAcl.ts`
 * re-exports {@link DEFAULT_SPAWNS_BY_ROLE} rather than keeping a second
 * copy, and `aclDefaults.test.ts` pins {@link DEFAULT_MEMORY_WRITE_BY_ROLE}
 * against `decideMemoryWrite` — the copy an operator reads must not be able
 * to drift from the rule that runs.
 */

import type { RoleLayer } from "./roleCatalog";
import type { SessionRole } from "./types";

/**
 * Canonical order of the layers for anything that lists them — the same
 * reason `AGENT_SPAWN_LAYERS` is ordered: two places describing the same ACL
 * must describe it in the same order.
 */
export const ACL_ROLE_ORDER: readonly SessionRole[] = [
  "conductor",
  "orchestrator",
  "worker",
  "plain-chat",
];

/**
 * What each layer may spawn when its persona does not say otherwise.
 *
 * `plain-chat` (an ordinary chat, in or out of the conductor graph) spawns
 * nothing programmatically — the operator keeps starting sessions through
 * the UI, which is not subject to this check.
 */
export const DEFAULT_SPAWNS_BY_ROLE: Record<SessionRole, readonly RoleLayer[]> =
  {
    conductor: ["orchestrator", "worker"],
    orchestrator: ["worker"],
    worker: [],
    "plain-chat": [],
  };

/**
 * How a layer's memory-write default answers before any persona grant:
 * `allowed` writes, `denied` never writes, `grant-required` writes only when
 * the persona carries `memory_write: true`.
 */
export type MemoryWriteDefault = "allowed" | "denied" | "grant-required";

/**
 * The memory-write default of each layer, mirroring `decideMemoryWrite`.
 *
 * The enforcement keeps its own switch — it also has to name WHY a refusal
 * happened, and a wave child is refused before its role is even read — so
 * this is a second statement of the same rule, held to it by a test.
 */
export const DEFAULT_MEMORY_WRITE_BY_ROLE: Record<
  SessionRole,
  MemoryWriteDefault
> = {
  conductor: "allowed",
  orchestrator: "grant-required",
  worker: "denied",
  "plain-chat": "allowed",
};
