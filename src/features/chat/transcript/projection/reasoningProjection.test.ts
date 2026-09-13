import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import {
  buildDuplicatedReasoningFixture,
  buildStreamingTurn,
  buildSyntheticReasoningTranscript,
  DUPLICATED_REASONING_FIXTURE_STREAMING_ID,
  digestHash,
  digestProjection,
  type ProjectedItemDigest,
  SYNTHETIC_STREAMING_MESSAGE_ID,
} from "../testing/reasoningProjectionFixtures";
import { createTranscriptProjectionCache } from "./transcriptProjectionCache";
import type { TranscriptProjectionSnapshot } from "./transcriptItemTypes";

const SESSION_ID = "session-reasoning";
const NOW_BUCKET = "2026-06-04";
const LOCALE_KEY = "en-US";

/**
 * Re-record with `RECORD_REASONING_PROJECTION=1 pnpm vitest run <this file>`
 * after an intentional projection change. The expected data was first captured
 * from the projection before the reasoning de-duplication was memoised, so the
 * comparison pins that the faster path projects exactly the same items.
 */
const RECORD = process.env.RECORD_REASONING_PROJECTION === "1";
const FIXTURE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
);
const EXPECTED_ITEMS_PATH = resolve(
  FIXTURE_DIR,
  "reasoningProjection.expected.json",
);

interface ExpectedProjection {
  items: ProjectedItemDigest[];
  syntheticDigest: string;
}

function readExpected(): ExpectedProjection {
  return JSON.parse(
    readFileSync(EXPECTED_ITEMS_PATH, "utf8"),
  ) as ExpectedProjection;
}

function project(
  cache: ReturnType<typeof createTranscriptProjectionCache>,
  messages: readonly Message[],
  streamingMessageId: string | null,
): TranscriptProjectionSnapshot {
  return cache.update({
    sessionId: SESSION_ID,
    sessionEpoch: 1,
    messages,
    streamingMessageId,
    nowBucket: NOW_BUCKET,
    localeKey: LOCALE_KEY,
  });
}

const SYNTHETIC_TURNS = 200;
const SYNTHETIC_PARAGRAPHS = 20;

function projectSynthetic(): ProjectedItemDigest[] {
  const cache = createTranscriptProjectionCache();
  const messages = [
    ...buildSyntheticReasoningTranscript({
      turns: SYNTHETIC_TURNS,
      paragraphsPerThought: SYNTHETIC_PARAGRAPHS,
    }),
    buildStreamingTurn(3),
  ];
  return digestProjection(
    project(cache, messages, SYNTHETIC_STREAMING_MESSAGE_ID),
  );
}

describe("reasoning de-duplication projection", () => {
  it("projects duplicated reasoning bodies exactly as recorded", () => {
    const cache = createTranscriptProjectionCache();
    const messages = buildDuplicatedReasoningFixture();
    const items = digestProjection(
      project(cache, messages, DUPLICATED_REASONING_FIXTURE_STREAMING_ID),
    );
    const syntheticDigest = digestHash(projectSynthetic());

    if (RECORD) {
      mkdirSync(FIXTURE_DIR, { recursive: true });
      writeFileSync(
        EXPECTED_ITEMS_PATH,
        `${JSON.stringify({ items, syntheticDigest }, null, 2)}\n`,
      );
      return;
    }

    const expected = readExpected();
    expect(items).toEqual(expected.items);
    expect(syntheticDigest).toBe(expected.syntheticDigest);
  });

  it("projects the same items on every streamed frame as a fresh projection", () => {
    const settled = buildDuplicatedReasoningFixture().filter(
      (message) => message.id !== DUPLICATED_REASONING_FIXTURE_STREAMING_ID,
    );
    const cache = createTranscriptProjectionCache();
    project(cache, settled, null);

    for (let frame = 0; frame < 6; frame += 1) {
      const messages = [...settled, buildStreamingTurn(frame)];
      const streamed = project(cache, messages, SYNTHETIC_STREAMING_MESSAGE_ID);
      const fresh = project(
        createTranscriptProjectionCache(),
        messages,
        SYNTHETIC_STREAMING_MESSAGE_ID,
      );
      expect(digestProjection(streamed)).toEqual(digestProjection(fresh));
    }

    const finished = [
      ...settled,
      {
        ...buildStreamingTurn(6),
        metadata: { userVisible: true, completionStatus: "completed" as const },
      },
    ];
    expect(digestProjection(project(cache, finished, null))).toEqual(
      digestProjection(
        project(createTranscriptProjectionCache(), finished, null),
      ),
    );
  });

  it("reuses settled agent-work items across streamed frames", () => {
    const settled = buildDuplicatedReasoningFixture().filter(
      (message) => message.id !== DUPLICATED_REASONING_FIXTURE_STREAMING_ID,
    );
    const cache = createTranscriptProjectionCache();
    const first = project(
      cache,
      [...settled, buildStreamingTurn(0)],
      SYNTHETIC_STREAMING_MESSAGE_ID,
    );
    const second = project(
      cache,
      [...settled, buildStreamingTurn(1)],
      SYNTHETIC_STREAMING_MESSAGE_ID,
    );

    const settledWorkItems = first.items.filter(
      (item) =>
        item.kind === "agent-work" &&
        item.messageId !== SYNTHETIC_STREAMING_MESSAGE_ID,
    );
    expect(settledWorkItems.length).toBeGreaterThan(10);
    for (const item of settledWorkItems) {
      const next = second.items.find(
        (candidate) => candidate.itemId === item.itemId,
      );
      expect(next).toBe(item);
    }
    const streamingWork = second.items.find(
      (item) =>
        item.kind === "agent-work" &&
        item.messageId === SYNTHETIC_STREAMING_MESSAGE_ID,
    );
    expect(streamingWork).toBeDefined();
    expect(first.items.includes(streamingWork as never)).toBe(false);
  });

  it("keeps the steady-state projection of a long reasoning transcript cheap", () => {
    const cache = createTranscriptProjectionCache();
    const settled = buildSyntheticReasoningTranscript({
      turns: SYNTHETIC_TURNS,
      paragraphsPerThought: SYNTHETIC_PARAGRAPHS,
    });
    project(cache, settled, null);

    const frameCosts: number[] = [];
    for (let frame = 0; frame < 12; frame += 1) {
      const messages = [...settled, buildStreamingTurn(frame)];
      const startedAt = performance.now();
      project(cache, messages, SYNTHETIC_STREAMING_MESSAGE_ID);
      frameCosts.push(performance.now() - startedAt);
    }
    frameCosts.sort((left, right) => left - right);
    const median = frameCosts[Math.floor(frameCosts.length / 2)] ?? 0;

    // The audit measured ~614 ms per frame for this transcript before the
    // agent-work projection was memoised; a generous bound still fails that by
    // an order of magnitude on any machine that runs the suite.
    expect(median).toBeLessThan(60);
  });
});
