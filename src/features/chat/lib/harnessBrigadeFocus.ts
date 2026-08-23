/**
 * Reveal seam for ephemeral harness subagents.
 *
 * An in-harness subagent has no session and therefore no chat to open: the
 * only thing behind its chip is the tool card in the steps panel. Clicking a
 * chip broadcasts a reveal request; any mounted agent-work panel that owns
 * that tool call expands itself, and the card is then scrolled into view.
 *
 * Every step degrades to a no-op: no document (SSR/tests), no listener, a
 * collapsed or virtualized-away card — nothing throws, nothing is required to
 * be mounted.
 */

/** Marks the DOM node of a single tool call inside the steps panel. */
export const TOOL_CALL_ID_ATTRIBUTE = "data-tool-call-id";

/** Document-level request to reveal one tool call. */
export const HARNESS_SUBAGENT_REVEAL_EVENT = "distill:harness-subagent-reveal";

export interface HarnessSubagentRevealDetail {
  toolCallId: string;
}

function findToolCard(toolCallId: string): HTMLElement | null {
  // Attribute-value selectors would need escaping for ids we do not control;
  // filtering the (small) marked set avoids that class of bug entirely.
  const candidates = document.querySelectorAll(`[${TOOL_CALL_ID_ATTRIBUTE}]`);
  for (const candidate of candidates) {
    if (
      candidate instanceof HTMLElement &&
      candidate.getAttribute(TOOL_CALL_ID_ATTRIBUTE) === toolCallId
    ) {
      return candidate;
    }
  }
  return null;
}

function scrollToToolCard(toolCallId: string): boolean {
  const element = findToolCard(toolCallId);
  if (!element) return false;
  if (typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "nearest" });
  }
  return true;
}

/**
 * Expand and scroll to a tool card. Safe to call when nothing is mounted.
 */
export function revealHarnessSubagentToolCall(toolCallId: string): void {
  if (typeof document === "undefined" || !toolCallId) return;

  document.dispatchEvent(
    new CustomEvent<HarnessSubagentRevealDetail>(
      HARNESS_SUBAGENT_REVEAL_EVENT,
      { detail: { toolCallId } },
    ),
  );

  if (scrollToToolCard(toolCallId)) return;
  if (typeof requestAnimationFrame !== "function") return;
  // The owning panel expands on the event above; its card only exists after
  // React has committed. Two frames is enough for the collapsible to mount.
  requestAnimationFrame(() => {
    if (scrollToToolCard(toolCallId)) return;
    if (typeof requestAnimationFrame !== "function") return;
    requestAnimationFrame(() => {
      scrollToToolCard(toolCallId);
    });
  });
}

/**
 * Subscribe to reveal requests. Returns an unsubscribe function; a no-op when
 * there is no document.
 */
export function onHarnessSubagentReveal(
  listener: (toolCallId: string) => void,
): () => void {
  if (typeof document === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<HarnessSubagentRevealDetail>).detail;
    if (detail?.toolCallId) listener(detail.toolCallId);
  };
  document.addEventListener(HARNESS_SUBAGENT_REVEAL_EVENT, handler);
  return () => {
    document.removeEventListener(HARNESS_SUBAGENT_REVEAL_EVENT, handler);
  };
}
