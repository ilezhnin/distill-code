/**
 * The order an effort menu is shown in: weakest stop first, strongest last,
 * whatever order the bridge listed them in.
 *
 * Bridges disagree. Claude and codex list their effort values ascending
 * (`default, low, …, max` / `low, …, ultra`), grok lists them descending
 * (`xhigh, high, medium, low`), and a slider that renders the list as given
 * puts grok's weakest stop under "Smarter". Only the order changes here: every
 * id and name is the bridge's own and is sent back exactly as it arrived.
 *
 * Ranks cover the vocabulary the three bridges use today. `default` sits first
 * because it is "whatever the model does by default", never a stronger stop.
 */
const EFFORT_RANK: ReadonlyMap<string, number> = new Map([
  ["default", 0],
  ["none", 1],
  ["off", 1],
  ["minimal", 2],
  ["low", 3],
  ["medium", 4],
  ["high", 5],
  ["xhigh", 6],
  ["max", 7],
  ["ultra", 8],
]);

function rankOf(id: string): number | undefined {
  return EFFORT_RANK.get(id.trim().toLowerCase());
}

/**
 * Effort options ordered weakest to strongest.
 *
 * When every id is known the list is sorted by rank. When some are not — a
 * bridge with its own words — the list is only reversed if the known ids run
 * strictly strongest-first, and otherwise left exactly as the bridge sent it:
 * guessing where an unknown stop belongs would invent an order nobody stated.
 */
export function orderEffortOptions<T extends { id: string }>(
  options: readonly T[],
): T[] {
  const ranks = options.map((option) => rankOf(option.id));
  if (ranks.every((rank) => rank !== undefined)) {
    return options
      .map((option, index) => ({ option, index, rank: ranks[index] as number }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .map(({ option }) => option);
  }
  const known = ranks.filter((rank): rank is number => rank !== undefined);
  const descending =
    known.length > 1 &&
    known.every((rank, index) => index === 0 || rank < known[index - 1]);
  return descending ? [...options].reverse() : [...options];
}
