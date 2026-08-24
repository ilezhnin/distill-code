/**
 * Projection of a delivered digest back into per-worker structure — UI-only.
 *
 * The digest text is a contract with two readers that must never change shape
 * underneath them: the conductor model judges it, and `parseDigestEnvelope`
 * re-finds it by its marker after any reload. This module is neither. It is
 * the third reader — the operator's — and it works backwards from the prose
 * `formatConductorAnswer` wrote, because that prose is the only carrier that
 * survives rehydration from ACP history. Adding a parallel structured payload
 * to the envelope would have meant changing what the conductor reads; parsing
 * the existing text changes nothing for either machine reader.
 *
 * Failure is graceful by construction: a body that yields no entries renders
 * through the card's old verbatim path, so a drift in the digest format
 * degrades to the previous rendering, never to a silent loss of the reports.
 */

import { i18n } from "@/shared/i18n";

import type { StructuredReport } from "./types";

export type DigestEntryStatus = StructuredReport["status"];

/** One worker's slice of the digest, as the card renders it. */
export interface DigestEntryView {
  /** The worker's display name, e.g. `Scout · waveEngine`. */
  displayName: string;
  status: DigestEntryStatus;
  /** The status verb exactly as the digest wrote it — already localized. */
  statusText: string;
  /** Everything under this worker's heading, verbatim. */
  body: string;
}

export interface DigestBodyView {
  /**
   * Machine-facing text before the first worker heading: the digest
   * instruction, and on a Q5 retry the parser's complaint. Constant protocol
   * chrome for the model, but kept readable on demand — the card must never
   * show less than the transcript actually holds.
   */
  preamble: string;
  entries: DigestEntryView[];
}

const REPORT_STATUSES: readonly DigestEntryStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

/**
 * Localized status word → canonical status.
 *
 * A heading is only believed when its status half maps here. That is what
 * keeps a worker's own bold prose (`**Warning** — flaky`) from being read as
 * a phantom worker: an arbitrary clause after the em-dash is not one of the
 * three words `formatConductorAnswer` can write. The canonical tokens are
 * included alongside the current locale so an English digest still projects
 * when the catalog has not finished loading.
 */
function statusByLabel(): Map<string, DigestEntryStatus> {
  const labels = new Map<string, DigestEntryStatus>();
  for (const status of REPORT_STATUSES) {
    labels.set(status, status);
    const localized = i18n.t(`chat:conductor.status.${status}`);
    if (localized) labels.set(localized, status);
  }
  return labels;
}

/** `**<name>** — <status>` — the exact heading `formatConductorAnswer` writes. */
const ENTRY_HEADING_PATTERN = /^\*\*(.+)\*\* — (.+)$/;

/**
 * Reads a digest body back into its per-worker entries.
 *
 * Anything before the first believed heading is the preamble; every heading
 * opens an entry that runs until the next one. Headings are not believed
 * inside code fences, because a worker's body may quote anything — including
 * text shaped like a digest.
 */
export function projectDigestBody(body: string): DigestBodyView {
  const statuses = statusByLabel();
  const preambleLines: string[] = [];
  const entries: DigestEntryView[] = [];
  let openEntry: {
    displayName: string;
    status: DigestEntryStatus;
    statusText: string;
    bodyLines: string[];
  } | null = null;
  let insideFence = false;

  const closeEntry = () => {
    if (!openEntry) return;
    entries.push({
      displayName: openEntry.displayName,
      status: openEntry.status,
      statusText: openEntry.statusText,
      body: openEntry.bodyLines.join("\n").trim(),
    });
    openEntry = null;
  };

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) {
      insideFence = !insideFence;
    }
    const heading = insideFence ? null : ENTRY_HEADING_PATTERN.exec(trimmed);
    const status = heading ? statuses.get(heading[2].trim()) : undefined;
    if (heading && status !== undefined) {
      closeEntry();
      openEntry = {
        displayName: heading[1].trim(),
        status,
        statusText: heading[2].trim(),
        bodyLines: [],
      };
      continue;
    }
    if (openEntry) {
      openEntry.bodyLines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  closeEntry();

  return { preamble: preambleLines.join("\n").trim(), entries };
}
