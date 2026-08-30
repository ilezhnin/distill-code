/**
 * Which harnesses accept guidance dropped into a turn that is already running.
 *
 * Steering is served by Goose's `_goose/unstable/session/steer`. Every harness
 * Distill offers runs inside Goose as a provider — the ACP ones are adapters
 * Goose spawns and speaks ACP to — and `SteerOperation` sits unconditionally
 * at the head of Goose's operation pipeline, ahead of the branch that skips
 * compaction for providers managing their own context. So the steer queue
 * drains at the next turn boundary whichever provider produced the turn.
 *
 * The set is explicit rather than "any non-empty harness". It names the
 * harnesses Distill ships and has exercised; a catalogued harness added later
 * has to be listed here deliberately rather than inherit an affordance nobody
 * ran a steer against, because an undrained steer is not visible as a
 * failure — Goose discards pending steers when the run finishes.
 *
 * Note this is not a guard against unknown providers: resolveSelectedAgentId
 * already collapses anything missing from the catalog to "goose" before this
 * check ever sees it.
 */
export const STEERING_SUPPORTED_HARNESS_IDS: ReadonlySet<string> = new Set([
  "goose",
  "claude-acp",
  "grok-acp",
  "codex-acp",
]);

export function supportsSteeringHarness(
  harnessId: string | null | undefined,
): boolean {
  return harnessId != null && STEERING_SUPPORTED_HARNESS_IDS.has(harnessId);
}
