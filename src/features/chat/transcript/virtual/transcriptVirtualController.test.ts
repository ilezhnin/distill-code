import { describe, expect, it } from "vitest";
import { TranscriptVirtualController } from "./transcriptVirtualController";

const VIEWPORT_HEIGHT = 600;
const BROWSER_SCROLL_HEIGHT = 2_000;
const BOTTOM_SCROLL_TOP = BROWSER_SCROLL_HEIGHT - VIEWPORT_HEIGHT;

// No history rows: everything the reader sees is content this engine does not
// own, like a streaming answer rendered in the live tail.
function createControllerWithoutRows() {
  const controller = new TranscriptVirtualController({
    sessionId: "session-1",
    sessionEpoch: 1,
    widthScope: "w:720",
    viewportHeight: VIEWPORT_HEIGHT,
    scrollTop: BOTTOM_SCROLL_TOP,
    browserScrollHeight: BROWSER_SCROLL_HEIGHT,
  });
  controller.setRows([]);
  return controller;
}

function viewportAt(scrollTop: number) {
  return {
    scrollTop,
    viewportHeight: VIEWPORT_HEIGHT,
    widthScope: "w:720",
    browserScrollHeight: BROWSER_SCROLL_HEIGHT,
  };
}

describe("TranscriptVirtualController anchor without anchorable rows", () => {
  it("keeps a viewport above the bottom where it is when later row updates reconcile", () => {
    const controller = createControllerWithoutRows();

    controller.syncViewport(viewportAt(800), {
      source: "browser",
      userScrollIntent: true,
    });
    expect(controller.getState().anchor).toEqual({
      type: "scroll-position",
      scrollTop: 800,
    });

    // A republish of the same position must not downgrade the anchor, and a
    // later row update must not move the viewport back to the bottom.
    controller.syncViewport(viewportAt(800), {
      source: "browser",
      userScrollIntent: true,
    });
    expect(controller.getState().anchor.type).toBe("scroll-position");
    expect(controller.setRows([]).correction).toBeNull();
    expect(controller.getState().scrollTop).toBe(800);
  });

  it("still follows the bottom when the reader is at the bottom", () => {
    const controller = createControllerWithoutRows();

    controller.syncViewport(viewportAt(BOTTOM_SCROLL_TOP), {
      source: "browser",
      userScrollIntent: true,
    });

    expect(controller.getState().anchor).toEqual({ type: "bottom" });
  });
});
