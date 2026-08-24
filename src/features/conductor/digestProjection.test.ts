import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";

import { projectDigestBody } from "./digestProjection";
import type { StructuredReport } from "./types";
import {
  buildGroupDigest,
  buildWaveDigest,
  parseDigestEnvelope,
} from "./waveDigest";

function report(summary: string, over: Partial<StructuredReport> = {}) {
  return {
    runId: "run-1",
    status: "completed" as const,
    summary,
    decisions: [],
    artifacts: [],
    risks: [],
    needsOperator: false,
    nextSuggestedTask: null,
    ...over,
  };
}

/** The body exactly as the card receives it: built, delivered, re-parsed. */
function digestBodyOf(
  entries: Parameters<typeof buildWaveDigest>[0]["entries"],
  verdictIssue?: Parameters<typeof buildWaveDigest>[0]["verdictIssue"],
): string {
  const digest = buildWaveDigest({
    waveId: "wave-1",
    attempt: 0,
    entries,
    ...(verdictIssue ? { verdictIssue } : {}),
  });
  const envelope = parseDigestEnvelope(digest);
  if (!envelope) throw new Error("built digest did not parse as an envelope");
  return envelope.body;
}

beforeAll(async () => {
  await i18n.loadNamespaces("chat");
});

describe("projectDigestBody", () => {
  it("reads a built wave digest back into one entry per worker", () => {
    const body = digestBodyOf([
      {
        node: { displayName: "Scout · waveEngine" },
        report: report("Found three callers"),
      },
      {
        node: { displayName: "Architect" },
        report: report("Could not finish", { status: "failed" }),
      },
    ]);

    const view = projectDigestBody(body);
    expect(view.entries).toHaveLength(2);
    expect(view.entries[0]).toMatchObject({
      displayName: "Scout · waveEngine",
      status: "completed",
      body: "Found three callers",
    });
    expect(view.entries[1]).toMatchObject({
      displayName: "Architect",
      status: "failed",
    });
    // The instruction the conductor was handed is chrome, not a worker.
    expect(view.preamble).toContain("WAVE REPORT DIGEST");
    expect(view.preamble).not.toContain("Found three callers");
  });

  it("keeps a worker's whole report — decisions, risks, the operator flag — in its body", () => {
    const body = digestBodyOf([
      {
        node: { displayName: "Curie" },
        report: report("Wrote the plan", {
          decisions: ["Chose vitest"],
          risks: ["Flaky in CI"],
          needsOperator: true,
        }),
      },
    ]);

    const view = projectDigestBody(body);
    expect(view.entries).toHaveLength(1);
    const entry = view.entries[0];
    expect(entry.body).toContain("Wrote the plan");
    expect(entry.body).toContain("Chose vitest");
    expect(entry.body).toContain("Flaky in CI");
    expect(entry.body).toContain(i18n.t("chat:conductor.needsOperator"));
  });

  it("does not read a worker's own bold prose as a phantom worker", () => {
    const body = digestBodyOf([
      {
        node: { displayName: "Curie" },
        report: report(
          "All good.\n**Warning** — the fixture is slow.\n**Note** — completed the sweep twice.",
        ),
      },
    ]);

    const view = projectDigestBody(body);
    // "the fixture is slow" is not a status word; "completed the sweep twice"
    // is not either. Both lines stay inside Curie's body.
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].body).toContain("**Warning**");
    expect(view.entries[0].body).toContain("**Note**");
  });

  it("does not read heading-shaped lines inside a quoted code fence", () => {
    const body = digestBodyOf([
      {
        node: { displayName: "Curie" },
        report: report(
          "Here is the diff:\n```\n**Bohr** — completed\n```\nDone.",
        ),
      },
    ]);

    const view = projectDigestBody(body);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].displayName).toBe("Curie");
    expect(view.entries[0].body).toContain("**Bohr** — completed");
  });

  it("survives the Q5 retry preamble, fenced verdict example and all", () => {
    const body = digestBodyOf(
      [{ node: { displayName: "Bohr" }, report: report("Still standing") }],
      { reason: "invalid", detail: 'Unknown verdict "looks-good".' },
    );

    const view = projectDigestBody(body);
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0].displayName).toBe("Bohr");
    expect(view.preamble).toContain('Unknown verdict "looks-good".');
    // The fenced verdict example belongs to the preamble, not to a worker.
    expect(view.entries[0].body).not.toContain("distill-verdict");
  });

  it("projects a group digest the same way", () => {
    const digest = buildGroupDigest({
      digestId: "parent::msg-1",
      entries: [
        { node: { displayName: "Atlas" }, report: report("Legacy work done") },
      ],
    });
    const envelope = parseDigestEnvelope(digest);
    const view = projectDigestBody(envelope?.body ?? "");
    expect(view.entries).toHaveLength(1);
    expect(view.entries[0]).toMatchObject({
      displayName: "Atlas",
      status: "completed",
      body: "Legacy work done",
    });
  });

  it("yields no entries for a body it cannot read, so the card can fall back", () => {
    expect(projectDigestBody("")).toEqual({ preamble: "", entries: [] });
    const view = projectDigestBody("Some unstructured text\nwith lines");
    expect(view.entries).toHaveLength(0);
    expect(view.preamble).toBe("Some unstructured text\nwith lines");
  });

  it("keeps the status verb as written for display, mapped for meaning", () => {
    const body = digestBodyOf([
      {
        node: { displayName: "Curie" },
        report: report("Stopped early", { status: "cancelled" }),
      },
    ]);
    const view = projectDigestBody(body);
    expect(view.entries[0].status).toBe("cancelled");
    expect(view.entries[0].statusText).toBe(
      i18n.t("chat:conductor.status.cancelled"),
    );
  });
});
