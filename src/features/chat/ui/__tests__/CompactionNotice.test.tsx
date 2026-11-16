import type { CompactionUpdate } from "@agentclientprotocol/sdk";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CompactionNotice } from "../CompactionNotice";

const NOW = Date.UTC(2026, 10, 14, 18, 0, 0);

/** What claude-agent-acp says a compaction did. */
const facts = (value: Record<string, unknown>) => ({
  jetbrains: { air: { contextCompaction: { version: 1, ...value } } },
});
const notice = () => screen.getByText(/./, { selector: "[role=status]" });
const fill = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-role='compaction-meter-fill']");

describe("CompactionNotice", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts a running compaction and measures the context it started from", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { container } = render(
      <CompactionNotice
        compaction={{ compactionId: "c", status: "in_progress" }}
        measure={{
          usedBefore: 129_200,
          size: 258_400,
          startedAt: NOW - 12_000,
        }}
      />,
    );

    expect(notice()).toHaveTextContent("Compacting conversation...");
    expect(container).toHaveTextContent("129k");
    expect(container).toHaveTextContent("12s");
    expect(fill(container)).toHaveStyle({ width: "50%" });
    // Nothing is behind a compaction that has written no summary.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says what a compaction did to the context from the host's measure", () => {
    const { container } = render(
      <CompactionNotice
        compaction={{ compactionId: "c", status: "completed" }}
        measure={{
          usedBefore: 244_380,
          usedAfter: 14_494,
          size: 258_400,
          startedAt: NOW - 41_000,
          endedAt: NOW,
        }}
      />,
    );

    expect(notice()).toHaveTextContent(
      "Conversation compacted: context went from 244k to 14k tokens.",
    );
    expect(container).toHaveTextContent("Compacted·244k → 14k·41s");
    expect(fill(container)?.style.width).toMatch(/^5\.6/);
  });

  it("prefers the bridge's own figures and opens onto its summary", async () => {
    const user = userEvent.setup();
    const compaction: CompactionUpdate = {
      compactionId: "c",
      status: "completed",
      summary: [{ type: "text", text: "The branch renames the store." }],
      _meta: facts({
        trigger: "manual",
        preTokens: 182_340,
        postTokens: 24_100,
        durationMs: 96_000,
      }),
    };
    const { container } = render(
      <CompactionNotice
        compaction={compaction}
        measure={{ usedBefore: 1, usedAfter: 1 }}
      />,
    );

    expect(container).toHaveTextContent("182k → 24k·1m 36s·manual");
    const summary = screen.getByRole("button", { name: "Summary" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("The branch renames the store.")).toBeNull();

    await user.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByText("The branch renames the store."),
    ).toBeInTheDocument();
  });

  it("claims no figures for a window that did not shrink or was never counted", () => {
    const { container, rerender } = render(
      <CompactionNotice
        compaction={{ compactionId: "c", status: "completed" }}
        measure={{ usedBefore: 100_000, usedAfter: 100_000, size: 200_000 }}
      />,
    );
    expect(container).toHaveTextContent(
      /^Conversation compacted\. .*Compacted$/,
    );
    expect(fill(container)).toHaveStyle({ width: "0%" });

    rerender(
      <CompactionNotice
        compaction={{ compactionId: "c", status: "completed" }}
      />,
    );
    expect(container).not.toHaveTextContent("→");
  });

  it("says why a compaction failed without anything to open", () => {
    const { container } = render(
      <CompactionNotice
        compaction={{
          compactionId: "c",
          status: "failed",
          error: "The summary request exceeded the context window.",
        }}
        measure={{ usedBefore: 251_000, size: 258_400 }}
      />,
    );

    expect(notice()).toHaveTextContent("Conversation compaction failed");
    expect(
      screen.getByText("The summary request exceeded the context window."),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent("→");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
