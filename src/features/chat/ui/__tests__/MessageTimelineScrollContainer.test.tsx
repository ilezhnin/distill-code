import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageTimelineScrollContainer } from "../MessageTimelineScrollContainer";

function renderScrollContainer(
  props: Partial<
    React.ComponentProps<typeof MessageTimelineScrollContainer>
  > = {},
) {
  render(
    <MessageTimelineScrollContainer hasFooter={false} {...props}>
      <div>Transcript</div>
    </MessageTimelineScrollContainer>,
  );

  return screen.getByTestId("message-timeline-scroll");
}

describe("MessageTimelineScrollContainer", () => {
  it("keeps a visible vertical scrollbar on the transcript", () => {
    const scroller = renderScrollContainer();

    expect(scroller).toHaveClass("scrollbar-visible", "overflow-y-scroll");
  });

  it("forwards wheel and pointer handlers so the timeline can detach from follow", () => {
    const onWheel = vi.fn();
    const onPointerDown = vi.fn();
    const scroller = renderScrollContainer({ onWheel, onPointerDown });

    fireEvent.wheel(scroller, { deltaY: 80 });
    fireEvent.pointerDown(scroller);

    expect(onWheel).toHaveBeenCalledOnce();
    expect(onPointerDown).toHaveBeenCalledOnce();
  });
});
