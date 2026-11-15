/**
 * Whether a wave step's executor could run now, by its provider's allowance.
 *
 * The ranking that offers a step its executors reads the status bar's
 * numbers: one account per provider, the default one. The host dispatches
 * on something else — every account the chat may use, spares included, and
 * the model it runs — so a step was handed to a model whose accounts had
 * all spent their allowance, and its first message only waited for a reset
 * hours away while the wave stood still (11-14). This asks the host the
 * question its dispatch asks, the way `flockctl session create` already
 * does before it starts a session.
 */

import { getNewChatAccountSelection } from "@/features/providers/api/providerAccounts";

/** A spent allowance: when the first account resets, if the provider says. */
export interface SpentAllowance {
  /** Epoch milliseconds, or null when the provider gives no reset time. */
  resetAt: number | null;
}

/**
 * How long one answer stands. A wave starts its steps within moments of
 * each other and each asks about the same few models; an allowance does not
 * come back within seconds.
 */
const ANSWER_TTL_MS = 15_000;

const answers = new Map<
  string,
  { at: number; answer: Promise<SpentAllowance | null> }
>();

function resetMillis(reset: number | null | undefined): number | null {
  if (typeof reset !== "number" || !Number.isFinite(reset) || reset <= 0)
    return null;
  // The host gives seconds for some providers and milliseconds for others.
  return reset < 1_000_000_000_000 ? reset * 1000 : reset;
}

/**
 * The spent allowance a new chat on `harnessId` running `modelId` would
 * meet, or null when it could run now. Null also when Flock reads no
 * allowance for the harness or could not read it: not knowing is no reason
 * to hold a step back.
 */
export function spentAllowance(
  harnessId: string,
  modelId: string | null | undefined,
  now = Date.now(),
): Promise<SpentAllowance | null> {
  const key = `${harnessId}\u0000${modelId ?? ""}`;
  const known = answers.get(key);
  if (known && now - known.at < ANSWER_TTL_MS) return known.answer;
  // Asked inside a promise: outside the app the call throws where it
  // stands, and not knowing must read as "could run".
  const answer = Promise.resolve()
    .then(() => getNewChatAccountSelection(harnessId, modelId))
    .then((selection) =>
      selection?.state === "wait"
        ? { resetAt: resetMillis(selection.nextReset) }
        : null,
    )
    .catch(() => null);
  answers.set(key, { at: now, answer });
  return answer;
}

/** What a step that cannot start for a spent allowance is told. */
export function spentAllowanceNote(
  label: string,
  spent: SpentAllowance,
): string {
  return spent.resetAt === null
    ? `${label}: every account it could run on has used up its allowance, and the provider gives no reset time`
    : `${label}: every account it could run on has used up its allowance until ${new Date(spent.resetAt).toISOString()}`;
}

export function resetWaveAllowanceForTests(): void {
  answers.clear();
}
