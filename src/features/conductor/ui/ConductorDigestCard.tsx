import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

import { type DigestEntryView, projectDigestBody } from "../digestProjection";
import type { SessionNode } from "../types";
import { BrigadeStatusGlyph } from "./BrigadeChip";

/**
 * A wave/brigade digest, rendered as a feed of per-worker cards.
 *
 * The digest is a genuine user message — that is the whole mechanism, it is
 * what wakes the parent's model — but it is not something the operator typed,
 * and rendering a wall of machine-facing report text as a chat bubble makes
 * the conversation unreadable. Contract 3 of the combined plan says card; the
 * original Distill's feed says the card should read as *the workers speaking*,
 * so each report is projected into its own sub-bubble: avatar, worker name,
 * status verb, and the report body under it.
 *
 * The projection is best-effort on purpose (`projectDigestBody`): a body that
 * yields no entries renders verbatim through the old path, and the expanded
 * view always shows everything the transcript holds — the reports are the only
 * record of what the brigade actually said, and a digest whose content could
 * not be read back would defeat the point of publishing it at all.
 */
export function ConductorDigestCard({
  body,
  agents,
  onOpen,
  className,
}: {
  body: string;
  /**
   * The conductor's own agents, so a report can lead back to the agent that
   * wrote it. The digest is frozen text and carries no session ids, so the
   * link is made on the display name — which the spawner keeps unique per
   * conductor (`pickUniqueDisplayName`) precisely so a name identifies one
   * agent. A name that matches nothing simply stays unclickable.
   */
  agents?: readonly SessionNode[];
  onOpen?: (sessionId: string) => void;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  // Entries carry no id of their own — they are read back out of frozen text —
  // so a stable key is minted per name occurrence. The list can never reorder
  // underneath these keys: a different body is a different digest message.
  const view = useMemo(() => {
    const projected = projectDigestBody(body);
    const occurrences = new Map<string, number>();
    const entries = projected.entries.map((entry) => {
      const occurrence = (occurrences.get(entry.displayName) ?? 0) + 1;
      occurrences.set(entry.displayName, occurrence);
      return { key: `${entry.displayName}#${occurrence}`, entry };
    });
    return { preamble: projected.preamble, entries };
  }, [body]);
  const hasEntries = view.entries.length > 0;
  // Ambiguity disqualifies: two live agents sharing a display name means we
  // cannot say which one wrote the report, and guessing would open the wrong
  // transcript — worse than not offering the link.
  const sessionIdByName = useMemo(() => {
    const byName = new Map<string, string | null>();
    for (const agent of agents ?? []) {
      byName.set(
        agent.displayName,
        byName.has(agent.displayName) ? null : agent.sessionId,
      );
    }
    return byName;
  }, [agents]);

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-accent p-2 text-xs text-muted-foreground",
        className,
      )}
      data-testid="conductor-digest-card"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate font-medium">
          {t("conductor.wave.digest.cardTitle")}
          {hasEntries
            ? ` · ${t("conductor.wave.digest.workerCount", {
                count: view.entries.length,
              })}`
            : null}
        </span>
        {body ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded
              ? t("conductor.wave.digest.collapse")
              : t("conductor.wave.digest.expand")}
          </Button>
        ) : null}
      </div>
      {hasEntries ? (
        <ul
          className="mt-2 flex list-none flex-col gap-1.5"
          data-testid="conductor-digest-entries"
        >
          {view.entries.map(({ key, entry }) => (
            <DigestEntryRow
              key={key}
              entry={entry}
              expanded={expanded}
              sessionId={sessionIdByName.get(entry.displayName)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      ) : null}
      {expanded && hasEntries && view.preamble ? (
        // The machine-facing instruction the conductor was handed — "reply
        // with exactly one distill-verdict block", and on a retry the
        // parser's complaint. It is part of what was actually delivered, so
        // the card must be able to show it; but expanding a digest is the
        // operator asking to read the *workers*, and answering that with a
        // paragraph addressed to a model is how the reports get skimmed past.
        // Its own disclosure, named for what it is: nothing hidden, nothing
        // in the way.
        <details
          className="mt-2"
          data-testid="conductor-digest-preamble-disclosure"
        >
          <summary className="cursor-pointer text-[11px] text-muted-foreground/70">
            {t("conductor.wave.digest.protocolText")}
          </summary>
          <p
            className="mt-1 whitespace-pre-wrap break-words text-[11px] text-muted-foreground/80"
            data-testid="conductor-digest-preamble"
          >
            {view.preamble}
          </p>
        </details>
      ) : null}
      {expanded && !hasEntries && body ? (
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans">
          {body}
        </pre>
      ) : null}
    </div>
  );
}

/**
 * One worker's report as a feed sub-bubble.
 *
 * Collapsed, the body is clamped to two lines — enough to read the opening of
 * the summary, the way the original Distill's feed previews an agent bubble.
 * Expanded, it is the report verbatim. The status dot reuses the brigade
 * chips' glyph so "what happened to this worker" looks the same wherever it
 * appears.
 */
function DigestEntryRow({
  entry,
  expanded,
  sessionId,
  onOpen,
}: {
  entry: DigestEntryView;
  expanded: boolean;
  /** The agent that wrote this report, when it could be identified. */
  sessionId?: string | null;
  onOpen?: (sessionId: string) => void;
}) {
  const canOpen = Boolean(sessionId && onOpen);
  const identity = (
    <>
      <WorkerAvatar name={entry.displayName} />
      <span className="truncate font-medium text-foreground">
        {entry.displayName}
      </span>
    </>
  );
  return (
    <li
      className="rounded-md bg-background p-2"
      data-testid="conductor-digest-entry"
      data-status={entry.status}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {canOpen ? (
          <button
            type="button"
            data-testid="conductor-digest-entry-open"
            className="flex min-w-0 items-center gap-1.5 rounded-sm text-left hover:underline"
            onClick={() => onOpen?.(sessionId as string)}
          >
            {identity}
          </button>
        ) : (
          identity
        )}
        <BrigadeStatusGlyph status={entry.status} />
        <span className="shrink-0" data-testid="conductor-digest-entry-status">
          {entry.statusText}
        </span>
      </div>
      {entry.body ? (
        <div
          className={cn(
            "mt-1 whitespace-pre-wrap break-words",
            !expanded && "line-clamp-2",
          )}
          data-testid="conductor-digest-entry-body"
        >
          {entry.body}
        </div>
      ) : null}
    </li>
  );
}

/**
 * The worker's avatar: its initial in a neutral disc.
 *
 * Deliberately not colored per worker — every color token this app has carries
 * run-status meaning (`BrigadeStatusGlyph`), and a decorative identity color
 * drawn from the same palette would read as a status. Identity is the letter
 * plus the name beside it.
 */
function WorkerAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-[11px] font-semibold text-foreground"
      data-testid="conductor-digest-entry-avatar"
    >
      {initial}
    </span>
  );
}
