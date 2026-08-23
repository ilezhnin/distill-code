import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HarnessBrigadeEntry } from "@/features/chat/lib/harnessBrigade";
import { HARNESS_SUBAGENT_REVEAL_EVENT } from "@/features/chat/lib/harnessBrigadeFocus";
import { renderWithProviders } from "@/test/render";

import { HarnessBrigadeRow } from "../HarnessBrigadeRow";

// Ephemeral harness subagents have no session and no graph node. Touching the
// graph store at all from this row is the bug this guard catches.
vi.mock("@/features/conductor/conductorGraphStore", () => {
  throw new Error("the harness brigade row must not reach the graph store");
});

const ENTRIES: HarnessBrigadeEntry[] = [
  {
    key: "toolu_01",
    name: "code-reviewer",
    label: "Review the auth module",
    status: "running",
    latestToolCallId: "toolu_07",
  },
  {
    key: "toolu_02",
    status: "completed",
    latestToolCallId: "toolu_02",
  },
];

describe("HarnessBrigadeRow", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders nothing without entries", () => {
    renderWithProviders(<HarnessBrigadeRow entries={[]} />);

    expect(screen.queryByTestId("harness-brigade-row")).toBeNull();
  });

  it("renders one chip per entry with its status and task tooltip", () => {
    renderWithProviders(<HarnessBrigadeRow entries={ENTRIES} />);

    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveAttribute("data-status", "running");
    expect(chips[0]).toHaveTextContent("code-reviewer");
    expect(
      chips[0].querySelector("[data-testid='conductor-agent-chip']"),
    ).toHaveAttribute("title", "Review the auth module");
    expect(chips[1]).toHaveAttribute("data-status", "completed");
  });

  it("falls back to a localized name when the harness named nothing", () => {
    renderWithProviders(<HarnessBrigadeRow entries={ENTRIES} />);

    expect(screen.getAllByTestId("brigade-chip")[1]).toHaveTextContent(
      "Subagent",
    );
  });

  it("never offers a stop button: there is no session to stop", () => {
    renderWithProviders(<HarnessBrigadeRow entries={ENTRIES} />);

    expect(screen.queryByTestId("conductor-agent-stop")).toBeNull();
  });

  it("asks for the latest tool call of the clicked entry", () => {
    const revealed: string[] = [];
    const listener = (event: Event) => {
      revealed.push(
        (event as CustomEvent<{ toolCallId: string }>).detail.toolCallId,
      );
    };
    document.addEventListener(HARNESS_SUBAGENT_REVEAL_EVENT, listener);

    try {
      renderWithProviders(<HarnessBrigadeRow entries={ENTRIES} />);
      fireEvent.click(screen.getAllByTestId("conductor-agent-chip")[0]);
    } finally {
      document.removeEventListener(HARNESS_SUBAGENT_REVEAL_EVENT, listener);
    }

    expect(revealed).toEqual(["toolu_07"]);
  });

  it("degrades to a no-op when the tool card is not mounted", () => {
    renderWithProviders(<HarnessBrigadeRow entries={ENTRIES} />);

    expect(() =>
      fireEvent.click(screen.getAllByTestId("conductor-agent-chip")[1]),
    ).not.toThrow();
  });
});
