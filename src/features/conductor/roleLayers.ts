/**
 * Single source of truth for "is this role id legal on this layer?".
 *
 * Contract #5 of the stage 0 plan: one role/layer validation module, shared by
 * the wave engine (`distillWave.ts`), `berdctl --role`, and the few-shot
 * example validator. `roleCatalog.ts` stays the data; this module is the only
 * place that answers questions about it.
 */

import {
  ROLE_CATALOG,
  type RoleDefinition,
  type RoleLayer,
  rolesForLayer,
} from "./roleCatalog";

/** Why a role id is not usable on the requested layer. */
export type RoleLayerIssue =
  /** The id is not in `ROLE_CATALOG` at all. */
  | "role-unknown"
  /** The id exists but the catalog does not list the requested layer. */
  | "role-wrong-layer";

export type RoleLayerCheck =
  | { ok: true; role: RoleDefinition }
  | { ok: false; issue: RoleLayerIssue; detail: string };

/**
 * Canonical form of a role id as written by a model: trimmed and lowercased.
 * Does not check existence — pair it with {@link resolveRoleInLayer}.
 */
export function normalizeRoleId(roleId: string): string {
  return roleId.trim().toLowerCase();
}

/** Role ids of every catalog entry that lists `layer`, in catalog order. */
export function roleIdsForLayer(layer: RoleLayer): readonly string[] {
  return rolesForLayer(layer).map((role) => role.id);
}

/** Role ids a wave step may use. Convenience wrapper over `roleIdsForLayer`. */
export function workerLayerRoleIds(): readonly string[] {
  return roleIdsForLayer("worker");
}

/**
 * Validates `roleId` against `layer`, returning either the catalog entry or an
 * enumerated issue plus an operator-readable detail string.
 */
export function resolveRoleInLayer(
  roleId: string,
  layer: RoleLayer,
): RoleLayerCheck {
  const normalized = normalizeRoleId(roleId);
  const role = ROLE_CATALOG.find((entry) => entry.id === normalized);
  if (!role) {
    return {
      ok: false,
      issue: "role-unknown",
      detail: `Unknown role "${roleId}". Known ${layer} roles: ${roleIdsForLayer(layer).join(", ")}.`,
    };
  }
  if (!role.layers.includes(layer)) {
    return {
      ok: false,
      issue: "role-wrong-layer",
      detail: `Role "${role.id}" is a ${role.layers.join("/")} role, not a ${layer} role.`,
    };
  }
  return { ok: true, role };
}

/** True when `roleId` names a catalog role that lists `layer`. */
export function isRoleInLayer(roleId: string, layer: RoleLayer): boolean {
  return resolveRoleInLayer(roleId, layer).ok;
}

/** True when `roleId` may be used as a wave step / worker session role. */
export function isWorkerLayerRole(roleId: string): boolean {
  return isRoleInLayer(roleId, "worker");
}

/** Display name for a role id, falling back to the raw id when unknown. */
export function roleDisplayName(roleId: string): string {
  const normalized = normalizeRoleId(roleId);
  return (
    ROLE_CATALOG.find((entry) => entry.id === normalized)?.displayName ?? roleId
  );
}
