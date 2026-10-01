import { expect, it } from "vitest";
import { createTranscriptProjectionCache } from "../projection";
import { createTranscriptTanStackVirtualAdapter } from "./transcriptTanStackVirtualAdapter";
import { TranscriptViewportCoordinator } from "./transcriptViewportCoordinator";

it("prepares a prepended range without clamping its anchor against the old DOM", () => {
  const rows = createTranscriptProjectionCache()
    .update({
      sessionId: "prepend",
      sessionEpoch: 1,
      streamingMessageId: null,
      nowBucket: "2026-09-28",
      localeKey: "en-US",
      messages: Array.from({ length: 60 }, (_, index) => ({
        id: `message-${index}`,
        role: "user" as const,
        created: 1,
        content: [{ type: "text" as const, text: `Question ${index}` }],
      })),
    })
    .rows.filter((row) => row.kind === "message");
  const container = document.createElement("div");
  let browserHeight = 1500;
  Object.defineProperties(container, {
    clientHeight: { value: 300 },
    clientWidth: { value: 720 },
    scrollHeight: { get: () => browserHeight },
  });
  const engine = createTranscriptTanStackVirtualAdapter({
    sessionId: "prepend",
    sessionEpoch: 1,
    widthScope: "w:720",
    viewportHeight: 300,
  });
  const coordinator = new TranscriptViewportCoordinator({
    container,
    engine,
    getFooterHeight: () => 0,
  });
  coordinator.setRows(rows.slice(40));
  container.scrollTop = 0;
  coordinator.syncViewport(
    { scrollTop: 0, viewportHeight: 300, widthScope: "w:720" },
    { source: "browser", userScrollIntent: true },
  );
  const anchor = coordinator.getState().anchor;
  expect(anchor.type).toBe("row");
  coordinator.setScrollWritesSuspended(true);
  const update = coordinator.setRows(rows);
  coordinator.setScrollWritesSuspended(false);
  expect(container.scrollTop).toBe(0);
  expect(update.correction?.nextScrollTop).toBeGreaterThan(1500);
  expect(coordinator.getRange().renderedRowIds).toContain(rows[40].rowId);
  browserHeight = coordinator.getRange().scrollHeight;
  coordinator.writeScrollTop(update.correction?.nextScrollTop ?? 0, {
    source: "correction",
  });
  expect(coordinator.getState().anchor).toEqual(anchor);
});
