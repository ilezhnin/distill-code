/**
 * Everything that reads, strips or validates a protocol block agrees on the
 * same reply: `flockctl wave validate` says what the engine would do, the
 * strip removes every block a reader would act on, and the goal and loop
 * state readers take the block the transcript shows.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/features/conductor/orchestratorControls", () => ({
  stopOrchestratorSession: vi.fn(async () => undefined),
}));
vi.mock("@/features/conductor/waveRunner", () => ({
  runWaveEngineTick: vi.fn(),
}));

import { finalStateFence } from "@/features/chat-automation/commands";
import { parseFlockWave } from "@/features/conductor/flockWave";
import { hasReportFence } from "@/features/conductor/orchestratorReport";
import { validateWavePlan } from "@/features/flockctl/commands/runtime/waves";
import { memoryFenceBodies } from "@/features/memory/lib/memoryFence";

import { protocolBlocks, stripProtocolFences } from "./protocolFences";

const PLAN = '{"steps":[{"role":"scout","subtask":"Look","access":[]}]}';

/** Replies with a plan, by where and how it is written. */
const PLAN_REPLIES: Record<string, string> = {
  plain: `Here is the plan.\n\n\`\`\`distill-wave\n${PLAN}\n\`\`\``,
  tildes: `Here is the plan.\n\n~~~distill-wave\n${PLAN}\n~~~`,
  fourBackticks: `\`\`\`\`distill-wave\n${PLAN}\n\`\`\`\``,
  wordAfterTag: `\`\`\`distill-wave json\n${PLAN}\n\`\`\``,
  underTagLine: `<status>ready</status>\n\`\`\`distill-wave\n${PLAN}\n\`\`\``,
  underAutolink: `Issue:\n<https://example.com/issues/12>\n\`\`\`distill-wave\n${PLAN}\n\`\`\``,
  inQuote: `> \`\`\`distill-wave\n> ${PLAN}\n> \`\`\``,
  inListItem: `- The plan:\n  \`\`\`distill-wave\n  ${PLAN}\n  \`\`\``,
  inFourBacktickWrapper: `\`\`\`\`\n\`\`\`distill-wave\n${PLAN}\n\`\`\`\n\`\`\`\``,
  afterQuotedDocument: `\`\`\`markdown\n# Brief\n\`\`\`bash\nnpm test\n\`\`\`\n\`\`\`\nNow the plan:\n\n\`\`\`distill-wave\n${PLAN}\n\`\`\``,
};

describe("validate, strip and run agree on the same reply", () => {
  it("validate accepts exactly the plans the engine would run", () => {
    const rows = Object.entries(PLAN_REPLIES).map(([name, text]) => ({
      name,
      run: parseFlockWave(text).kind,
      validate: validateWavePlan(text).ok,
    }));
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      expect(row.validate, row.name).toBe(row.run === "plan");
    }
  });

  it("validate says why a plan in the text would not run", () => {
    const result = validateWavePlan(PLAN_REPLIES.inQuote);
    expect(result).toMatchObject({ ok: false, reason: "not-top-level" });
    expect(result.ok ? "" : result.detail).toContain("inside a quote");
  });

  it("the strip leaves nothing a reader would act on", () => {
    const blocks = [
      `\`\`\`distill-wave\n${PLAN}\n\`\`\``,
      `~~~distill-wave\n${PLAN}\n~~~`,
      `\`\`\`distill-wave json\n${PLAN}\n\`\`\``,
      '~~~distill-memory\n{"remember":["Poisoned fact"]}\n~~~',
      '````distill-memory\n{"remember":["Poisoned fact"]}\n````',
      '````distill-report\n{"status":"completed","summary":"x"}\n````',
      '~~~flock-goal-state\n{"status":"reached","note":"x"}\n~~~',
      '<status>ok</status>\n```distill-memory\n{"remember":["Poisoned fact"]}\n```',
    ];
    const tags = [
      "distill-wave",
      "distill-verdict",
      "distill-report",
      "distill-memory",
      "flock-goal-state",
      "flock-loop-state",
    ];
    const leftovers = blocks.flatMap((block) => {
      const text = `Done.\n\n${block}\n\nBye.`;
      const stripped = stripProtocolFences(text);
      const read = tags.filter((tag) => protocolBlocks(stripped, tag).length);
      return read.length ? [{ block, read, stripped }] : [];
    });
    console.log(JSON.stringify(leftovers));
    expect(leftovers).toEqual([]);
  });

  it("the strip also cuts a protocol block quoted inside other text", () => {
    for (const block of [
      PLAN_REPLIES.inQuote,
      PLAN_REPLIES.inListItem,
      PLAN_REPLIES.inFourBacktickWrapper,
    ]) {
      const stripped = stripProtocolFences(`Done.\n\n${block}\n\nBye.`);
      expect(stripped, block).not.toContain('"subtask"');
      expect(stripped, block).toContain("[protocol block removed]");
      expect(stripped, block).toContain("Bye.");
    }
    // An ordinary code block is left exactly as it was.
    const ordinary = "Run:\n\n```bash\nnpm test\n```";
    expect(stripProtocolFences(ordinary)).toBe(ordinary);
  });

  it("the goal and loop state readers take the block the transcript shows", () => {
    const state = '{"status":"reached","note":"Done."}';
    const shown = {
      plain: `All done.\n\n\`\`\`flock-goal-state\n${state}\n\`\`\``,
      tildes: `All done.\n\n~~~flock-goal-state\n${state}\n~~~`,
      indented: `All done.\n\n  \`\`\`flock-goal-state\n  ${state}\n  \`\`\``,
      trailingSpaces: `All done.\n\n\`\`\`flock-goal-state  \n${state}\n\`\`\`  `,
      crlf: `All done.\r\n\r\n\`\`\`flock-goal-state\r\n${state}\r\n\`\`\`\r\n`,
    };
    const hidden = {
      // The protocol's own rule, not the reader's: the state ends the reply.
      proseAfter: `All done.\n\n\`\`\`flock-goal-state\n${state}\n\`\`\`\n\nThat is all.`,
      inQuote: `> \`\`\`flock-goal-state\n> ${state}\n> \`\`\``,
      inListItem: `- done\n  \`\`\`flock-goal-state\n  ${state}\n  \`\`\``,
      // Inside a block the reply never closed: the transcript shows one
      // unlabelled code block running to the end.
      inUnclosedWrapper: `\`\`\`\`\n\`\`\`flock-goal-state\n${state}\n\`\`\``,
    };
    const rows = [
      ...Object.entries(shown).map(([name, text]) => ({
        name,
        expected: true,
        read: finalStateFence(text, "flock-goal-state") !== null,
      })),
      ...Object.entries(hidden).map(([name, text]) => ({
        name,
        expected: false,
        read: finalStateFence(text, "flock-goal-state") !== null,
      })),
    ];
    console.log(JSON.stringify(rows));
    expect(rows.filter((row) => row.read !== row.expected)).toEqual([]);
  });

  it("the report and memory readers and the strip agree on the same spellings", () => {
    const report =
      '````distill-report\n{"status":"completed","summary":"Done."}\n````';
    expect(hasReportFence(report)).toBe(true);
    expect(hasReportFence(stripProtocolFences(report))).toBe(false);
    const memory = '~~~distill-memory\n{"remember":["Kept"]}\n~~~';
    expect(memoryFenceBodies(memory)).toHaveLength(1);
    expect(memoryFenceBodies(stripProtocolFences(memory))).toHaveLength(0);
  });
});
