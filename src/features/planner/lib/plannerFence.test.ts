import { describe, expect, it } from "vitest";

import {
  PLANNER_PROTOCOL_PROMPT,
  parseFenceDate,
  parsePlannerFences,
  TODO_FENCE_TAG,
} from "./plannerFence";
import { startOfLocalDay } from "./plannerTask";

function fence(body: string): string {
  return ["Here is what I found.", "", "```distill-todo", body, "```"].join(
    "\n",
  );
}

describe("parsePlannerFences", () => {
  it("has nothing to say about ordinary prose", () => {
    expect(parsePlannerFences("Done. Nothing else to add.")).toBeNull();
  });

  it("reads a task with every field the protocol offers", () => {
    const parsed = parsePlannerFences(
      fence(
        '{"add":[{"title":"Renew the certificate","due":"2026-09-01","priority":"high","repeat":"daily","notes":"expires Monday"}]}',
      ),
    );

    expect(parsed?.add).toEqual([
      {
        title: "Renew the certificate",
        dueAt: startOfLocalDay(new Date(2026, 8, 1).getTime()),
        priority: "high",
        repeat: { kind: "daily" },
        notes: "expires Monday",
      },
    ]);
  });

  it("accepts a bare string, because that is what a hurried model writes", () => {
    const parsed = parsePlannerFences(fence('{"add":["Call the notary"]}'));
    expect(parsed?.add[0]).toMatchObject({
      title: "Call the notary",
      dueAt: null,
      priority: "normal",
      repeat: null,
    });
  });

  it("reads a bare array as the add list", () => {
    const parsed = parsePlannerFences(fence('[{"title":"Bare"}]'));
    expect(parsed?.add.map((entry) => entry.title)).toEqual(["Bare"]);
  });

  it("merges every block in one message rather than taking the first", () => {
    const text = [
      fence('{"add":["First"]}'),
      fence('{"add":["Second"],"complete":["Old thing"]}'),
    ].join("\n\n");

    const parsed = parsePlannerFences(text);
    expect(parsed?.add.map((entry) => entry.title)).toEqual([
      "First",
      "Second",
    ]);
    expect(parsed?.complete).toEqual(["Old thing"]);
  });

  it("survives a block that is not JSON at all", () => {
    expect(parsePlannerFences(fence("just some words"))).toBeNull();
  });

  it("drops an entry with no usable title instead of the whole block", () => {
    const parsed = parsePlannerFences(
      fence('{"add":[{"title":"   "},{"title":"Real one"},42]}'),
    );
    expect(parsed?.add.map((entry) => entry.title)).toEqual(["Real one"]);
  });

  it("is nothing when the block asks for nothing", () => {
    expect(parsePlannerFences(fence('{"add":[],"complete":[]}'))).toBeNull();
  });

  it("can be called twice on the same text", () => {
    // The pattern is global; a leaked lastIndex would make the second read
    // find nothing, and the scan calls this on every store tick.
    const text = fence('{"add":["Twice"]}');
    expect(parsePlannerFences(text)).toEqual(parsePlannerFences(text));
  });
});

describe("parseFenceDate", () => {
  it("reads YYYY-MM-DD as the start of that local day", () => {
    expect(parseFenceDate("2026-09-01")).toBe(
      startOfLocalDay(new Date(2026, 8, 1).getTime()),
    );
  });

  it("refuses a day that does not exist rather than rolling into next month", () => {
    expect(parseFenceDate("2026-02-31")).toBeNull();
  });

  it("refuses anything that is not a plain date", () => {
    expect(parseFenceDate("tomorrow")).toBeNull();
    expect(parseFenceDate(20260901)).toBeNull();
    expect(parseFenceDate(undefined)).toBeNull();
  });
});

describe("PLANNER_PROTOCOL_PROMPT", () => {
  it("shows the agent the tag the reader actually looks for", () => {
    expect(PLANNER_PROTOCOL_PROMPT).toContain(TODO_FENCE_TAG);
    // The prompt's own example must parse, or the protocol documents a
    // format nothing can read.
    expect(parsePlannerFences(PLANNER_PROTOCOL_PROMPT)).not.toBeNull();
  });
});
