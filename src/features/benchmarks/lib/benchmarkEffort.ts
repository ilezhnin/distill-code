// "default" is not an effort level. A request that leaves the effort to the
// CLI runs at whatever level the CLI picks, and the bridge acknowledges only
// the word, so nobody can tell which effort such a measurement measured. The
// service refuses to plan it and leaves it out of every analysis; nothing
// here offers it or names it as an effort.

/** The word a bridge acknowledges when a request left the effort to its CLI. */
export const CLI_DEFAULT_EFFORT = "default";

/**
 * The order a run starts a model's effort at, highest first. "ultra" hands
 * work to subagents, so it is never chosen for the operator.
 */
const PRESELECTION_ORDER = ["max", "xhigh", "high", "medium", "low", "minimal"];

/** `effort` when it names a level, else null. */
export function explicitEffort(
  effort: string | null | undefined,
): string | null {
  return effort && effort !== CLI_DEFAULT_EFFORT ? effort : null;
}

/** The levels a model lists, without the CLI's "default". */
export function explicitEfforts(efforts: readonly string[]): string[] {
  return efforts.filter((effort) => explicitEffort(effort) !== null);
}

/**
 * The level a model starts at: its highest listed level, else the first it
 * lists other than "ultra", else none for the operator to pick.
 */
export function preselectedEffort(efforts: readonly string[]): string | null {
  const levels = explicitEfforts(efforts);
  return (
    PRESELECTION_ORDER.find((effort) => levels.includes(effort)) ??
    levels.find((effort) => effort !== "ultra") ??
    null
  );
}
