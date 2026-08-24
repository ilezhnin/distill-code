import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";

import type { StructuredReport } from "../types";
import { buildWaveDigest, parseDigestEnvelope } from "../waveDigest";
import { ConductorDigestCard } from "./ConductorDigestCard";

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

/** What `MessageBubble` actually hands the card: the envelope's body. */
function builtBody(
  entries: Parameters<typeof buildWaveDigest>[0]["entries"],
): string {
  const envelope = parseDigestEnvelope(
    buildWaveDigest({ waveId: "wave-1", attempt: 0, entries }),
  );
  if (!envelope) throw new Error("built digest did not parse as an envelope");
  return envelope.body;
}

beforeAll(async () => {
  await i18n.loadNamespaces("chat");
});

describe("ConductorDigestCard", () => {
  it("renders one sub-bubble per worker: avatar initial, name, status verb", () => {
    render(
      <ConductorDigestCard
        body={builtBody([
          {
            node: { displayName: "Scout · waveEngine" },
            report: report("Found three callers"),
          },
          {
            node: { displayName: "Architect" },
            report: report("Could not finish", { status: "failed" }),
          },
        ])}
      />,
    );

    const entries = screen.getAllByTestId("conductor-digest-entry");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toHaveAttribute("data-status", "completed");
    expect(entries[0]).toHaveTextContent("Scout · waveEngine");
    expect(entries[0]).toHaveTextContent("Found three callers");
    expect(entries[1]).toHaveAttribute("data-status", "failed");
    expect(entries[1]).toHaveTextContent("Architect");

    const avatars = screen.getAllByTestId("conductor-digest-entry-avatar");
    expect(avatars[0]).toHaveTextContent("S");
    expect(avatars[1]).toHaveTextContent("A");

    // The status verb is the digest's own word for it, shown as written.
    const statuses = screen.getAllByTestId("conductor-digest-entry-status");
    expect(statuses[0]).toHaveTextContent(
      i18n.t("chat:conductor.status.completed"),
    );
    expect(statuses[1]).toHaveTextContent(
      i18n.t("chat:conductor.status.failed"),
    );

    // The worker count sits in the card header.
    expect(screen.getByTestId("conductor-digest-card")).toHaveTextContent(
      i18n.t("chat:conductor.wave.digest.workerCount", { count: 2 }),
    );
  });

  it("clamps the report collapsed and shows it whole — with the protocol preamble — expanded", () => {
    render(
      <ConductorDigestCard
        body={builtBody([
          {
            node: { displayName: "Curie" },
            report: report("Wrote the plan", { decisions: ["Chose vitest"] }),
          },
        ])}
      />,
    );

    const entryBody = screen.getByTestId("conductor-digest-entry-body");
    expect(entryBody).toHaveClass("line-clamp-2");
    // The machine-facing instruction is not shown while collapsed.
    expect(
      screen.queryByTestId("conductor-digest-preamble"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("chat:conductor.wave.digest.expand"),
      }),
    );

    expect(screen.getByTestId("conductor-digest-entry-body")).not.toHaveClass(
      "line-clamp-2",
    );
    expect(screen.getByTestId("conductor-digest-entry-body")).toHaveTextContent(
      "Chose vitest",
    );
    // Nothing the transcript holds is unreachable: the instruction text the
    // conductor was handed is readable once expanded.
    expect(screen.getByTestId("conductor-digest-preamble")).toHaveTextContent(
      "WAVE REPORT DIGEST",
    );
  });

  it("falls back to the verbatim body when the text does not project", () => {
    render(<ConductorDigestCard body={"Some unstructured text"} />);

    expect(
      screen.queryByTestId("conductor-digest-entries"),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("chat:conductor.wave.digest.expand"),
      }),
    );
    expect(screen.getByTestId("conductor-digest-card")).toHaveTextContent(
      "Some unstructured text",
    );
  });
});
