import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import {
  buildDuplicatedReasoningFixture,
  buildStreamingTurn,
  buildSyntheticReasoningTranscript,
  DUPLICATED_REASONING_FIXTURE_STREAMING_ID,
  digestProjection,
  SYNTHETIC_STREAMING_MESSAGE_ID,
} from "../testing/reasoningProjectionFixtures";
import { createTranscriptProjectionCache } from "./transcriptProjectionCache";
import type { TranscriptProjectionSnapshot } from "./transcriptItemTypes";

const SESSION_ID = "session-reasoning";
const NOW_BUCKET = "2026-06-04";
const LOCALE_KEY = "en-US";

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

describe("reasoning de-duplication projection", () => {
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
