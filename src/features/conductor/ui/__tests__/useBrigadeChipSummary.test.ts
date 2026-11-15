import { beforeEach, describe, expect, it } from "vitest";

import {
  noteSessionUpdate,
  resetSessionPulsesForTests,
} from "@/features/chat/lib/sessionPulse";

import {
  CHIP_QUIET_AFTER_MS,
  formatBrigadeChipReason,
  formatProviderWait,
  quietTurnMs,
} from "../useBrigadeChipSummary";

const t = (key: string) => key;

describe("formatBrigadeChipReason", () => {
  it("says a provider turned the requests away in plain words", () => {
    expect(
      formatBrigadeChipReason(
        "exceeded retry limit, last status: 429 Too Many Requests",
        t,
      ),
    ).toBe("conductor.chip.rateLimited");
    expect(formatBrigadeChipReason("Too many requests", t)).toBe(
      "conductor.chip.rateLimited",
    );
  });

  it("keeps every other reason as the host gave it", () => {
    expect(formatBrigadeChipReason("The sandbox could not start", t)).toBe(
      "The sandbox could not start",
    );
    expect(formatBrigadeChipReason("Wrote 4290 rows", t)).toBe(
      "Wrote 4290 rows",
    );
    expect(formatBrigadeChipReason(undefined, t)).toBeUndefined();
  });
});

describe("quietTurnMs", () => {
  const START = 1_000_000;
  beforeEach(() => {
    resetSessionPulsesForTests();
  });

  it("says how long a running turn has sent nothing, once that is long", () => {
    noteSessionUpdate("s", { sessionUpdate: "agent_message_chunk" }, START);
    expect(quietTurnMs("s", true, START + 30_000)).toBeNull();
    expect(quietTurnMs("s", true, START + CHIP_QUIET_AFTER_MS - 1)).toBeNull();
    expect(quietTurnMs("s", true, START + CHIP_QUIET_AFTER_MS)).toBe(
      CHIP_QUIET_AFTER_MS,
    );
    // The model speaks again: the row goes back to what it is doing.
    noteSessionUpdate(
      "s",
      { sessionUpdate: "agent_thought_chunk" },
      START + 5 * 60_000,
    );
    expect(quietTurnMs("s", true, START + 5 * 60_000 + 1_000)).toBeNull();
  });

  it("is not a turn that ended, one waiting on its tool, or one never heard", () => {
    const late = START + 10 * 60_000;
    expect(quietTurnMs("never-heard", true, late)).toBeNull();
    noteSessionUpdate("s", { sessionUpdate: "agent_message_chunk" }, START);
    expect(quietTurnMs("s", false, late)).toBeNull();
    // A long build in a tool call says nothing for as long as it runs.
    noteSessionUpdate(
      "s",
      {
        sessionUpdate: "tool_call",
        toolCallId: "build",
        status: "in_progress",
      },
      START,
    );
    expect(quietTurnMs("s", true, late)).toBeNull();
    noteSessionUpdate(
      "s",
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "build",
        status: "completed",
      },
      START + 60_000,
    );
    expect(quietTurnMs("s", true, late)).toBe(9 * 60_000);
  });
});

describe("formatProviderWait", () => {
  const time = (at: number) => `at:${at}`;
  const tWith = (key: string, options?: Record<string, unknown>) =>
    `${key}|${String(options?.time)}`;

  it("says an agent the provider rate-limited waits, and until when", () => {
    expect(
      formatProviderWait({ reason: "rate_limit", retryAt: 42 }, tWith, time),
    ).toBe("conductor.chip.rateLimitWait|at:42");
  });

  it("says the same of a spent quota in its own words", () => {
    expect(
      formatProviderWait({ reason: "quota", retryAt: 7 }, tWith, time),
    ).toBe("conductor.chip.quotaWait|at:7");
  });
});
