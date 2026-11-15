import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  selectHarnessBrigade,
  subagentUsageFromResult,
} from "@/features/chat/lib/harnessBrigade";
import type { MessageContent } from "@/shared/types/messages";

import { HarnessBrigadeRow, harnessChipWords } from "../HarnessBrigadeRow";

const START = Date.UTC(2026, 10, 14, 18, 0, 0);

const t = (key: string, options?: Record<string, unknown>) =>
  options?.count !== undefined ? `${options.count} tools` : key;

/** One Claude Code `Agent` call, and its result when it has one. */
function agentCall(
  id: string,
  args: Record<string, unknown>,
  result?: string,
): MessageContent[] {
  return [
    {
      type: "toolRequest",
      id,
      name: "Agent",
      toolName: "Agent",
      arguments: args,
      status: result === undefined ? "in_progress" : "completed",
      startedAt: START,
    },
    ...(result === undefined
      ? []
      : [
          {
            type: "toolResponse" as const,
            id,
            name: "Agent",
            result,
            isError: false,
          },
        ]),
  ];
}

const USAGE_TAGS =
  "Done.\n<usage><subagent_tokens>105405</subagent_tokens><tool_uses>43</tool_uses><duration_ms>136742</duration_ms></usage>";

describe("subagentUsageFromResult", () => {
  it("reads the usage a subagent's result ends with, as tags or as lines", () => {
    expect(subagentUsageFromResult(USAGE_TAGS)).toEqual({
      tokens: 105405,
      toolUses: 43,
      durationMs: 136742,
    });
    expect(
      subagentUsageFromResult(
        "Done.\n<usage>total_tokens: 12345\ntool_uses: 7\nduration_ms: 61000</usage>",
      ),
    ).toEqual({ tokens: 12345, toolUses: 7, durationMs: 61000 });
    // Only what the block names.
    expect(
      subagentUsageFromResult("<usage><tool_uses>3</tool_uses></usage>"),
    ).toEqual({ toolUses: 3 });
  });

  it("is nothing for a result that reports no usage", () => {
    expect(subagentUsageFromResult(undefined)).toBeUndefined();
    expect(subagentUsageFromResult("Found 12 callers.")).toBeUndefined();
    expect(subagentUsageFromResult("<usage></usage>")).toBeUndefined();
    // Numbers in the answer itself are not its usage.
    expect(
      subagentUsageFromResult("tool_uses: 9 were needed, total_tokens: 5"),
    ).toBeUndefined();
  });
});

describe("in-harness subagent chips", () => {
  it("names six subagents of one kind by what each was asked to do", () => {
    const tasks = [
      "Fix sandbox test infrastructure",
      "Map quota-aware executor routing",
      "Map progress, verification, restart",
      "Audit the renderer's content policy",
      "Trace the git hardening",
      "Review the broker token",
    ];
    const entries = selectHarnessBrigade({
      content: tasks.flatMap((description, index) =>
        agentCall(`call-${index}`, {
          subagent_type: "fork",
          description,
          prompt: "…",
        }),
      ),
      turnFinished: false,
    });
    const words = entries.map((entry) => harnessChipWords(entry, t, START));
    // Before, every one of these read "fork".
    expect(words.map((chip) => chip.name)).toEqual(tasks);
    expect(new Set(words.map((chip) => chip.kindLabel))).toEqual(
      new Set(["fork"]),
    );
  });

  it("counts a working subagent's time, and says what a finished one spent", () => {
    const [working] = selectHarnessBrigade({
      content: agentCall("a", { subagent_type: "Explore", description: "Map" }),
      turnFinished: false,
    });
    expect(harnessChipWords(working, t, START + 80_000)).toMatchObject({
      name: "Map",
      kindLabel: "Explore",
      summaryLabel: "1m 20s",
    });

    const [finished] = selectHarnessBrigade({
      content: agentCall(
        "b",
        { subagent_type: "Explore", description: "Map" },
        USAGE_TAGS,
      ),
      turnFinished: true,
    });
    expect(finished.status).toBe("completed");
    expect(harnessChipWords(finished, t, START + 999_000)).toMatchObject({
      summaryLabel: "105k · 43 tools · 2m 16s",
    });

    // A result that reports nothing leaves the chip without numbers.
    const [silent] = selectHarnessBrigade({
      content: agentCall("c", { description: "Check the links" }, "Done."),
      turnFinished: true,
    });
    expect(harnessChipWords(silent, t, START).summaryLabel).toBeUndefined();
  });

  it("keeps a named agent's name when the call says nothing else", () => {
    const [named] = selectHarnessBrigade({
      content: agentCall("a", { subagent_type: "code-reviewer" }),
      turnFinished: false,
    });
    const words = harnessChipWords(named, t, START);
    expect(words.name).toBe("code-reviewer");
    expect(words.kindLabel).toBeUndefined();

    // The default kind is no name at all: the task alone.
    const [plain] = selectHarnessBrigade({
      content: agentCall("b", {
        subagent_type: "general-purpose",
        description: "Draft the release notes",
      }),
      turnFinished: false,
    });
    expect(harnessChipWords(plain, t, START)).toMatchObject({
      name: "Draft the release notes",
    });
    expect(harnessChipWords(plain, t, START).kindLabel).toBeUndefined();
  });

  it("draws the task, the kind and the numbers on the chip", () => {
    const entries = selectHarnessBrigade({
      content: agentCall(
        "a",
        { subagent_type: "fork", description: "Fix sandbox tests" },
        USAGE_TAGS,
      ),
      turnFinished: true,
    });
    render(<HarnessBrigadeRow entries={entries} />);
    const chip = screen.getByTestId("conductor-agent-chip");
    expect(chip).toHaveTextContent("Fix sandbox tests");
    expect(screen.getByTestId("brigade-chip-kind")).toHaveTextContent("fork");
    expect(screen.getByTestId("brigade-chip-summary")).toHaveTextContent(
      "105k",
    );
    // The tooltip keeps both, whatever the chip had room for.
    expect(chip).toHaveAttribute("title", "Fix sandbox tests\nfork");
  });
});
