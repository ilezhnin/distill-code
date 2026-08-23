import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  ConductorTranscriptProvider,
  type ConductorTranscriptContextValue,
} from "@/features/conductor/ConductorTranscriptContext";
import { buildWaveDigest } from "@/features/conductor/waveDigest";
import type { Message } from "@/shared/types/messages";

import { MessageBubble } from "../MessageBubble";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  openUrl: vi.fn(),
}));

const DIGEST_TEXT = buildWaveDigest({
  waveId: "wave-1",
  attempt: 0,
  entries: [
    {
      node: { displayName: "Curie" },
      report: {
        runId: "run-1",
        status: "completed",
        summary: "Found three callers",
        decisions: [],
        artifacts: [],
        risks: [],
        needsOperator: false,
        nextSuggestedTask: null,
      },
    },
  ],
});

function renderBubble(message: Message, enabled = true) {
  const value: ConductorTranscriptContextValue = {
    enabled,
    children: [],
    reportsByRunId: {},
    brigadeNodesByMessageId: new Map(),
    wavePlanStepsByMessageId: new Map(),
  };
  return render(
    <ConductorTranscriptProvider value={value}>
      <MessageBubble message={message} />
    </ConductorTranscriptProvider>,
  );
}

describe("digest messages render as a compact card", () => {
  const digestMessage: Message = {
    id: "d1",
    role: "user",
    created: 0,
    content: [{ type: "text", text: DIGEST_TEXT }],
    metadata: { origin: "berdctl_cross_session" },
  };

  it("folds the report body behind a card instead of a chat bubble", () => {
    renderBubble(digestMessage);

    expect(screen.getByTestId("conductor-digest-card")).toBeInTheDocument();
    // The machine-facing marker and the report body are not in the transcript
    // as loose text.
    expect(screen.queryByText(/distill-digest/)).toBeNull();
    expect(screen.queryByText(/Found three callers/)).toBeNull();
  });

  it("still lets the operator read what the brigade actually said", () => {
    renderBubble(digestMessage);

    fireEvent.click(screen.getByRole("button", { name: "Show report" }));
    expect(screen.getByTestId("conductor-digest-card")).toHaveTextContent(
      "Found three callers",
    );
  });

  it("escapes the user-bubble width clamp at every level of the row", () => {
    // jsdom has no layout engine, so this is a class assertion, not a measured
    // one: it asserts that neither the content box nor the wrapper above it
    // (which is what actually bounds the box) still carries the user-message
    // max-width. The wrapper was the one that kept it, so a digest rendered
    // narrow and right-aligned.
    const { container } = renderBubble(digestMessage);

    const card = screen.getByTestId("conductor-digest-card");
    const clamped = Array.from(
      container.querySelectorAll<HTMLElement>(
        "[class*='--chat-user-message-max-width']",
      ),
    ).filter((element) => element.contains(card));
    expect(clamped).toEqual([]);

    const box = card.closest("[data-role='user-message-content']");
    expect(box).not.toBeNull();
    expect(box?.parentElement?.className).toContain("w-full");
    expect(box?.parentElement?.className).toContain("items-start");
  });

  it("keeps the width clamp for an ordinary user bubble", () => {
    const { container } = renderBubble({
      id: "m3",
      role: "user",
      created: 0,
      content: [{ type: "text", text: "Just a message" }],
    });

    expect(
      container.querySelectorAll("[class*='--chat-user-message-max-width']")
        .length,
    ).toBeGreaterThan(0);
  });

  it("leaves an ordinary cross-session message as a normal bubble", () => {
    renderBubble({
      id: "m1",
      role: "user",
      created: 0,
      content: [{ type: "text", text: "Check the CI failure" }],
      metadata: { origin: "berdctl_cross_session" },
    });

    expect(screen.queryByTestId("conductor-digest-card")).toBeNull();
    expect(screen.getByText("Check the CI failure")).toBeInTheDocument();
  });

  it("does not card a digest-shaped message the operator typed themselves", () => {
    renderBubble({
      id: "m2",
      role: "user",
      created: 0,
      content: [{ type: "text", text: DIGEST_TEXT }],
    });

    expect(screen.queryByTestId("conductor-digest-card")).toBeNull();
  });
});
