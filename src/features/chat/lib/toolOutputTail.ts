const TAIL_CHARS = 120;

/**
 * The last line a running tool has printed, for the step's header: the
 * progress a long command reports ("mat: 30000 materials") instead of only
 * the seconds it has run. `null` when there is no line to show.
 */
export function lastOutputLine(
  output: string | undefined | null,
  maxChars = TAIL_CHARS,
): string | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
  }
  return null;
}
