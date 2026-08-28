import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { i18n } from "@/shared/i18n";

import { appendRunEvent, resetRunJournalsForTests } from "../runJournal";
import { RawEventRail } from "./RawEventRail";

beforeAll(async () => {
  await i18n.loadNamespaces("chat");
});

afterEach(resetRunJournalsForTests);

const BASE = 1_000_000;

function event(over: Partial<Parameters<typeof appendRunEvent>[0]> = {}) {
  appendRunEvent({
    at: BASE,
    kind: "step-spawned",
    waveId: "w1",
    conductorSessionId: "c1",
    rootRequestId: "r1",
    ...over,
  });
}

describe("RawEventRail", () => {
  it("says so plainly when nothing was recorded", () => {
    render(<RawEventRail waveId="w1" />);
    expect(screen.getByTestId("raw-event-rail-empty")).toBeInTheDocument();
  });

  it("shows what the app recorded, in order, with the gaps visible", () => {
    // Wall-clock timestamps answer "when, on a Tuesday". The question a trace
    // is read for is "how long was the gap".
    event({ kind: "wave-admitted", detail: { steps: 2 } });
    event({
      at: BASE + 9_000,
      sessionId: "s1",
      stepIndex: 0,
      detail: { model: "gpt-5.6-sol[low]" },
    });

    render(<RawEventRail waveId="w1" />);

    const rows = screen.getAllByTestId("raw-event-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-kind", "wave-admitted");
    expect(rows[0]).toHaveTextContent("+0.0s");
    expect(rows[1]).toHaveTextContent("+9.0s");
    // The fact the live run needed and nothing kept: which model the step
    // actually landed on.
    expect(rows[1]).toHaveTextContent("model=gpt-5.6-sol[low]");
    expect(rows[1]).toHaveTextContent("#1");
  });

  it("narrows to one executor, keeping the wave-wide events around it", () => {
    event({ kind: "wave-admitted" });
    event({ sessionId: "s1", detail: { name: "Bohr" } });
    event({ sessionId: "s2", detail: { name: "Curie" } });

    render(<RawEventRail waveId="w1" sessionId="s1" />);

    const text = screen.getByTestId("raw-event-rail").textContent ?? "";
    expect(text).toContain("Bohr");
    expect(text).not.toContain("Curie");
    expect(text).toContain("wave-admitted");
  });

  it("shows another wave nothing of this one's", () => {
    event({});
    render(<RawEventRail waveId="w2" />);
    expect(screen.getByTestId("raw-event-rail-empty")).toBeInTheDocument();
  });
});
