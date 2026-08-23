/**
 * Every decision the child-chat tab strip makes, as pure functions.
 *
 * The store (`childChatTabsStore`) and the panel (`ChildChatPanel`) hold no
 * rules of their own: which tabs end up open, which one is active after a
 * close, whether a chip is even allowed to open a tab, and which surface owns
 * the shared side region all live here so they can be tested without React.
 */

/**
 * How many child transcripts may sit in the strip at once.
 *
 * A wave is capped at 5 steps (D1), so 6 holds a full wave plus one tab
 * carried over from the previous one. Past that the strip stops being a
 * glanceable row of workers and the oldest tab is the one the operator has
 * stopped caring about.
 */
export const MAX_CHILD_CHAT_TABS = 6;

/** One open child transcript. Identity is the child's session id. */
export interface ChildChatTab {
  /** The child session whose transcript this tab shows. */
  sessionId: string;
  /**
   * Label captured when the tab opened. The strip prefers the live graph name
   * when the node still exists; this is the fallback for a node that has since
   * been dropped from the graph.
   */
  name: string;
}

/**
 * Which surface owns the one side region next to the conversation.
 *
 * The row only has space for a single panel: the artifact viewer already
 * reserves a ~300px floor for itself and forces the conversation to its own
 * floor (see `ArtifactViewerPanel`), so mounting a second panel beside it
 * would push the conversation under that floor. Rather than let two panels
 * fight, the region is shared and the child chat wins while it is open —
 * opening a worker's transcript is the more recent and more explicit operator
 * action. Nothing is lost: the artifact tabs stay in their own store and the
 * viewer comes back when the last child tab closes.
 */
export type SidePanelSurface = "none" | "artifact" | "child-chat";

export function resolveSidePanelSurface(input: {
  hasChildChatTab: boolean;
  hasArtifact: boolean;
}): SidePanelSurface {
  if (input.hasChildChatTab) return "child-chat";
  if (input.hasArtifact) return "artifact";
  return "none";
}

/**
 * Whether a chip click may open a transcript tab at all.
 *
 * Two things disqualify it:
 *  - the chip carries no real session (ephemeral in-harness subagents never
 *    reach this path, but a caller that lost the id must not open an empty
 *    tab either), or the id is the host conversation itself — showing the same
 *    transcript twice, side by side, is noise;
 *  - the id is not one of this conversation's known graph children, so there
 *    is no transcript we can honestly claim to be showing.
 *
 * A `false` here is not a dead end: the caller falls back to full navigation.
 */
export function canOpenChildChatTab(input: {
  childSessionId: string | null | undefined;
  hostSessionId: string | null | undefined;
  childSessionIds: readonly string[];
}): boolean {
  const { childSessionId, hostSessionId, childSessionIds } = input;
  if (!childSessionId) return false;
  if (hostSessionId && childSessionId === hostSessionId) return false;
  return childSessionIds.includes(childSessionId);
}

/**
 * The tab list after opening `tab`.
 *
 * Re-opening an already-open child keeps its position (the operator's strip
 * does not reshuffle under them) and refreshes the label. A genuinely new tab
 * is appended; once the strip is over cap the oldest tabs fall off the front,
 * which is also the order in which they stopped being interesting.
 */
export function openChildChatTabs(
  tabs: readonly ChildChatTab[],
  tab: ChildChatTab,
  cap: number = MAX_CHILD_CHAT_TABS,
): ChildChatTab[] {
  const existingIndex = tabs.findIndex(
    (open) => open.sessionId === tab.sessionId,
  );
  const next =
    existingIndex >= 0
      ? tabs.map((open, index) => (index === existingIndex ? tab : open))
      : [...tabs, tab];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Which tab is active after `closedSessionId` goes away.
 *
 * Closing a background tab must not move the operator; closing the active one
 * lands on its right-hand neighbour, falling back to the left. Mirrors the
 * artifact viewer's `neighborPath` so both strips behave the same.
 */
export function activeChildTabAfterClose(
  tabs: readonly ChildChatTab[],
  activeSessionId: string | null | undefined,
  closedSessionId: string,
): string | null {
  if (activeSessionId !== closedSessionId) {
    const stillOpen = tabs.some(
      (tab) =>
        tab.sessionId === activeSessionId && tab.sessionId !== closedSessionId,
    );
    return stillOpen ? (activeSessionId ?? null) : null;
  }
  const index = tabs.findIndex((tab) => tab.sessionId === closedSessionId);
  if (index < 0) return tabs[0]?.sessionId ?? null;
  return tabs[index + 1]?.sessionId ?? tabs[index - 1]?.sessionId ?? null;
}

/**
 * The tab a given active id resolves to. An id that is no longer in the list
 * falls back to the first tab, so the panel can never render an empty body
 * while tabs are visibly open.
 */
export function resolveActiveChildTab(
  tabs: readonly ChildChatTab[] | undefined,
  activeSessionId: string | null | undefined,
): ChildChatTab | null {
  if (!tabs || tabs.length === 0) return null;
  return (
    tabs.find((tab) => tab.sessionId === activeSessionId) ?? tabs[0] ?? null
  );
}
