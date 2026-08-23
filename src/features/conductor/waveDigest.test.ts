import { beforeAll, describe, expect, it } from "vitest";

import { i18n } from "@/shared/i18n";
import type { Message } from "@/shared/types/messages";

import type { StructuredReport } from "./types";
import {
  DIGEST_MARKER_PREFIX,
  buildGroupDigest,
  buildWaveDigest,
  digestMarker,
  findDigestMessageIndex,
  findVerdictMessageAfter,
  isDigestMessage,
  parseDigestEnvelope,
  stripProtocolFences,
  waveDigestMarker,
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

function userMessage(id: string, text: string, origin = true): Message {
  return {
    id,
    role: "user",
    created: 1,
    content: [{ type: "text", text }],
    ...(origin
      ? { metadata: { origin: "berdctl_cross_session" as const } }
      : {}),
  };
}

function assistantMessage(
  id: string,
  text: string,
  inProgress = false,
): Message {
  return {
    id,
    role: "assistant",
    created: 1,
    content: [{ type: "text", text }],
    metadata: {
      completionStatus: inProgress
        ? ("inProgress" as const)
        : ("completed" as const),
    },
  };
}

beforeAll(async () => {
  await i18n.loadNamespaces("chat");
});

describe("digest markers", () => {
  it("round-trips through the envelope parser", () => {
    const text = `${waveDigestMarker("wave-1", 0)}\nSome body\nand more`;
    const envelope = parseDigestEnvelope(text);
    expect(envelope).toEqual({
      digestKey: "wave-1#0",
      body: "Some body\nand more",
    });
  });

  it("distinguishes delivery attempts, so a retried digest is a new anchor", () => {
    expect(waveDigestMarker("wave-1", 0)).not.toBe(
      waveDigestMarker("wave-1", 1),
    );
  });

  it("sanitises ids that would break the marker syntax", () => {
    const marker = digestMarker("session x::plan ]1", 0);
    expect(marker.startsWith(DIGEST_MARKER_PREFIX)).toBe(true);
    expect(parseDigestEnvelope(`${marker}\nbody`)?.digestKey).toBe(
      "session-x::plan--1#0",
    );
  });

  it("reads nothing out of an ordinary message", () => {
    expect(parseDigestEnvelope("Please look at the failing test")).toBeNull();
    expect(parseDigestEnvelope("")).toBeNull();
    // A marker that is not on the first line is not an envelope.
    expect(
      parseDigestEnvelope(`hello\n${waveDigestMarker("wave-1", 0)}`),
    ).toBeNull();
  });

  it("only calls a cross-session user message a digest", () => {
    const text = `${waveDigestMarker("wave-1", 0)}\nbody`;
    expect(isDigestMessage(userMessage("m1", text))).toBe(true);
    // Same text typed by the operator is not a digest.
    expect(isDigestMessage(userMessage("m2", text, false))).toBe(false);
    // Nor is an assistant message quoting it back.
    expect(isDigestMessage(assistantMessage("m3", text))).toBe(false);
  });
});

describe("finding the verdict anchor", () => {
  const marker = waveDigestMarker("wave-1", 0);
  const messages: Message[] = [
    assistantMessage("plan", "the plan"),
    userMessage("digest", `${marker}\nreports`),
    assistantMessage("verdict", "the verdict"),
    assistantMessage("later", "something else"),
  ];

  it("locates the digest and reads the first settled answer after it", () => {
    const index = findDigestMessageIndex(messages, marker);
    expect(index).toBe(1);
    expect(findVerdictMessageAfter(messages, index)?.id).toBe("verdict");
  });

  it("waits while the answer is still streaming", () => {
    const streaming: Message[] = [
      messages[0],
      messages[1],
      assistantMessage("verdict", "```distill-verdict", true),
    ];
    expect(findVerdictMessageAfter(streaming, 1)).toBeUndefined();
  });

  it("finds nothing when the digest is not in the transcript yet", () => {
    expect(
      findDigestMessageIndex(messages, waveDigestMarker("wave-1", 1)),
    ).toBe(-1);
    expect(findDigestMessageIndex(undefined, marker)).toBe(-1);
    expect(findVerdictMessageAfter(messages, -1)).toBeUndefined();
  });
});

describe("stripProtocolFences", () => {
  it("cuts protocol blocks a worker quoted into its summary", () => {
    const text =
      'Here is what I found.\n\n```distill-wave\n{"steps":[]}\n```\n\nDone.';
    const stripped = stripProtocolFences(text);
    expect(stripped).not.toContain("distill-wave");
    expect(stripped).toContain("[protocol block removed]");
    expect(stripped).toContain("Here is what I found.");
  });

  it("leaves ordinary code fences alone", () => {
    const text = "```ts\nconst x = 1;\n```";
    expect(stripProtocolFences(text)).toBe(text);
  });
});

describe("buildWaveDigest", () => {
  const entries = [
    { node: { displayName: "Curie" }, report: report("Found three callers") },
    {
      node: { displayName: "Bohr" },
      report: report("Wrote the test plan", { risks: ["Flaky in CI"] }),
    },
  ];

  it("is one message covering every step, not one per worker", () => {
    const digest = buildWaveDigest({ waveId: "wave-1", attempt: 0, entries });
    expect(digest.split(DIGEST_MARKER_PREFIX)).toHaveLength(2);
    expect(digest).toContain("Curie");
    expect(digest).toContain("Bohr");
    expect(digest).toContain("Found three callers");
    expect(digest).toContain("Flaky in CI");
  });

  it("tells the reader this is a report to judge, not an operator request", () => {
    const digest = buildWaveDigest({ waveId: "wave-1", attempt: 0, entries });
    expect(digest).toContain("WAVE REPORT DIGEST");
    expect(digest).toContain("not a request from the operator");
    expect(digest).toContain("distill-verdict");
  });

  it("carries no live protocol fence out of a worker's own text", () => {
    const digest = buildWaveDigest({
      waveId: "wave-1",
      attempt: 0,
      entries: [
        {
          node: { displayName: "Curie" },
          report: report(
            'I suggest:\n```distill-wave\n{"steps":[{"role":"scout","subtask":"go","access":[]}]}\n```',
          ),
        },
      ],
    });
    // The only wave fence anywhere in a digest would be one a worker quoted;
    // it is cut, so the conductor is never handed a plan inside a report.
    expect(digest).not.toContain("```distill-wave");
  });

  it("starts with the marker so the envelope parser can read it back", () => {
    const digest = buildWaveDigest({ waveId: "wave-1", attempt: 2, entries });
    expect(parseDigestEnvelope(digest)?.digestKey).toBe("wave-1#2");
  });
});

describe("buildGroupDigest", () => {
  it("demands no verdict — the parent may be an ordinary chat", () => {
    const digest = buildGroupDigest({
      digestId: "parent::msg-1",
      entries: [
        { node: { displayName: "Atlas" }, report: report("Legacy work done") },
      ],
    });
    expect(digest).toContain("AGENT REPORT DIGEST");
    expect(digest).not.toContain("distill-verdict");
    expect(digest).toContain("Legacy work done");
    expect(parseDigestEnvelope(digest)?.digestKey).toBe("parent::msg-1#0");
  });
});
