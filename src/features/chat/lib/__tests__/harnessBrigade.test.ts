import { describe, expect, it } from "vitest";

import {
  NO_HARNESS_BRIGADE,
  selectHarnessBrigade,
} from "@/features/chat/lib/harnessBrigade";
import type { MessageContent, ToolCallStatus } from "@/shared/types/messages";

function request(
  id: string,
  toolName: string,
  args: Record<string, unknown>,
  status: ToolCallStatus = "in_progress",
  extra: Partial<Extract<MessageContent, { type: "toolRequest" }>> = {},
): MessageContent {
  return {
    type: "toolRequest",
    id,
    name: toolName,
    toolName,
    arguments: args,
    status,
    ...extra,
  };
}

function response(
  id: string,
  result: string,
  isError = false,
  structuredContent?: unknown,
): MessageContent {
  return {
    type: "toolResponse",
    id,
    name: "result",
    result,
    isError,
    ...(structuredContent === undefined ? {} : { structuredContent }),
  };
}

function text(value: string): MessageContent {
  return { type: "text", text: value };
}

describe("selectHarnessBrigade", () => {
  it("returns the shared empty result for content with no subagent calls", () => {
    expect(
      selectHarnessBrigade({
        content: [
          text("thinking about it"),
          request("t1", "developer__shell", { command: "ls" }, "completed"),
          response("t1", "a\nb"),
        ],
        turnFinished: true,
      }),
    ).toBe(NO_HARNESS_BRIGADE);
  });

  it("returns the shared empty result for empty content", () => {
    expect(selectHarnessBrigade({ content: [], turnFinished: false })).toBe(
      NO_HARNESS_BRIGADE,
    );
  });

  describe("Claude Code Task/Agent", () => {
    it("projects a fan-out of Task calls in spawn order", () => {
      const content: MessageContent[] = [
        request(
          "toolu_01",
          "Task",
          {
            subagent_type: "code-reviewer",
            description: "Review the auth module",
            prompt: "Look at src/auth and report risks",
          },
          "completed",
        ),
        request(
          "toolu_02",
          "Task",
          {
            subagent_type: "test-writer",
            description: "Write tests for the parser",
          },
          "in_progress",
        ),
        response("toolu_01", "Review done: 2 findings"),
      ];

      expect(selectHarnessBrigade({ content, turnFinished: false })).toEqual([
        {
          key: "toolu_01",
          name: "code-reviewer",
          label: "Review the auth module",
          status: "completed",
          latestToolCallId: "toolu_01",
        },
        {
          key: "toolu_02",
          name: "test-writer",
          label: "Write tests for the parser",
          status: "running",
          latestToolCallId: "toolu_02",
        },
      ]);
    });

    it("falls back to the task description when the subagent is general-purpose", () => {
      const entries = selectHarnessBrigade({
        content: [
          request("toolu_10", "Agent", {
            subagent_type: "general-purpose",
            description: "Audit the dependency tree",
          }),
        ],
        turnFinished: false,
      });

      expect(entries).toEqual([
        {
          key: "toolu_10",
          name: "Audit the dependency tree",
          label: "Audit the dependency tree",
          status: "running",
          latestToolCallId: "toolu_10",
        },
      ]);
    });

    it("keeps two subagents of the same name apart, keyed by tool call id", () => {
      const content: MessageContent[] = [
        request(
          "toolu_a",
          "Task",
          { subagent_type: "researcher", description: "Read the RFCs" },
          "completed",
        ),
        request("toolu_b", "Task", {
          subagent_type: "researcher",
          description: "Read the changelogs",
        }),
        response("toolu_a", "ok"),
      ];

      const entries = selectHarnessBrigade({ content, turnFinished: false });

      expect(entries.map((entry) => entry.key)).toEqual(["toolu_a", "toolu_b"]);
      expect(entries.map((entry) => entry.name)).toEqual([
        "researcher",
        "researcher",
      ]);
      expect(entries.map((entry) => entry.status)).toEqual([
        "completed",
        "running",
      ]);
    });

    it("keeps the same keys as the turn streams on", () => {
      const spawned = request("toolu_a", "Task", {
        subagent_type: "researcher",
        description: "Read the RFCs",
      });
      const streaming = selectHarnessBrigade({
        content: [spawned],
        turnFinished: false,
      });
      const settled = selectHarnessBrigade({
        content: [
          request(
            "toolu_a",
            "Task",
            { subagent_type: "researcher", description: "Read the RFCs" },
            "completed",
          ),
          response("toolu_a", "done"),
        ],
        turnFinished: true,
      });

      expect(streaming[0].key).toBe(settled[0].key);
      expect(streaming[0].status).toBe("running");
      expect(settled[0].status).toBe("completed");
    });
  });

  describe("Ultracode-style workflow fan-out", () => {
    it("shows one chip per spawned worker with its own status", () => {
      const content: MessageContent[] = [
        text("Running the workflow."),
        request(
          "wf_1",
          "Task",
          {
            subagent_type: "ultracode-planner",
            description: "Plan the change",
          },
          "completed",
        ),
        response("wf_1", "plan ready"),
        request(
          "wf_2",
          "Task",
          {
            subagent_type: "ultracode-implementer",
            description: "Apply step 1",
          },
          "completed",
        ),
        response("wf_2", "patch applied"),
        request(
          "wf_3",
          "Task",
          {
            subagent_type: "ultracode-verifier",
            description: "Run the checks",
          },
          "failed",
        ),
        response("wf_3", "tests failed", true),
        request("wf_4", "Task", {
          subagent_type: "ultracode-reporter",
          description: "Summarize",
        }),
      ];

      const entries = selectHarnessBrigade({ content, turnFinished: false });

      expect(entries.map((entry) => [entry.name, entry.status])).toEqual([
        ["ultracode-planner", "completed"],
        ["ultracode-implementer", "completed"],
        ["ultracode-verifier", "failed"],
        ["ultracode-reporter", "running"],
      ]);
    });

    it("terminalizes everything still hanging when the turn finishes", () => {
      const content: MessageContent[] = [
        request(
          "wf_1",
          "Task",
          { subagent_type: "planner", description: "Plan" },
          "completed",
        ),
        response("wf_1", "ok"),
        request("wf_2", "Task", {
          subagent_type: "implementer",
          description: "Apply",
        }),
        request(
          "wf_3",
          "Task",
          { subagent_type: "verifier", description: "Verify" },
          "pending",
        ),
      ];

      expect(
        selectHarnessBrigade({ content, turnFinished: true }).map(
          (entry) => entry.status,
        ),
      ).toEqual(["completed", "cancelled", "cancelled"]);
    });

    it("maps a stopped tool call to cancelled without waiting for the turn", () => {
      expect(
        selectHarnessBrigade({
          content: [
            request(
              "wf_1",
              "Task",
              { subagent_type: "planner", description: "Plan" },
              "stopped",
            ),
          ],
          turnFinished: false,
        })[0].status,
      ).toBe("cancelled");
    });
  });

  describe("Goose delegate + load(task_id)", () => {
    const delegated: MessageContent[] = [
      request(
        "goose_1",
        "delegate",
        {
          source: "Rivet",
          instructions: "Count the markdown files under docs/",
          async: true,
        },
        "completed",
      ),
      response(
        "goose_1",
        "Started background task 20260807_72. Use load to await it.",
      ),
    ];

    it("updates the delegate's own entry instead of creating a second chip", () => {
      const content: MessageContent[] = [
        ...delegated,
        request("goose_2", "load", { source: "20260807_72" }),
      ];

      const entries = selectHarnessBrigade({ content, turnFinished: false });

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        key: "goose_1",
        name: "Rivet",
        label: "Count the markdown files under docs/",
        status: "running",
        latestToolCallId: "goose_2",
      });
    });

    it("follows the await to completion", () => {
      const content: MessageContent[] = [
        ...delegated,
        request("goose_2", "load", { source: "20260807_72" }, "completed"),
        response("goose_2", "Task 20260807_72 finished: 42 files"),
      ];

      const entries = selectHarnessBrigade({ content, turnFinished: true });

      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe("goose_1");
      expect(entries[0].name).toBe("Rivet");
      expect(entries[0].status).toBe("completed");
    });

    it("follows the await to failure", () => {
      const entries = selectHarnessBrigade({
        content: [
          ...delegated,
          request("goose_2", "load", { source: "20260807_72" }, "failed"),
          response("goose_2", "task crashed", true),
        ],
        turnFinished: true,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe("failed");
    });

    it("cancels the delegate's chip through a load(cancel)", () => {
      const entries = selectHarnessBrigade({
        content: [
          ...delegated,
          request(
            "goose_2",
            "load",
            { source: "20260807_72", cancel: true },
            "stopped",
          ),
        ],
        turnFinished: false,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].status).toBe("cancelled");
    });

    it("resolves the task id out of structured content too", () => {
      const entries = selectHarnessBrigade({
        content: [
          request(
            "goose_1",
            "delegate",
            { source: "Rivet", instructions: "Count files" },
            "completed",
          ),
          response("goose_1", "started", false, { task_id: "20260807_72" }),
          request("goose_2", "load", { source: "20260807_72" }),
        ],
        turnFinished: false,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe("goose_1");
    });

    it("does not attribute a task id to a delegate that only shares its prefix", () => {
      const entries = selectHarnessBrigade({
        content: [
          request(
            "goose_1",
            "delegate",
            { source: "Rivet", instructions: "Count files" },
            "completed",
          ),
          response("goose_1", "Started background task 20260807_7"),
          request("goose_2", "load", { source: "20260807_72" }),
        ],
        turnFinished: false,
      });

      expect(entries).toHaveLength(2);
      expect(entries[1].key).toBe("goose_2");
    });

    it("keeps the stamped identity when the spawning delegate is out of view", () => {
      const entries = selectHarnessBrigade({
        content: [
          request("goose_9", "load", { source: "20260807_72" }, "in_progress", {
            subagentAgentName: "Rivet",
            subagentTaskLabel: "Count the markdown files",
          }),
        ],
        turnFinished: false,
      });

      expect(entries).toEqual([
        {
          key: "goose_9",
          name: "Rivet",
          label: "Count the markdown files",
          status: "running",
          latestToolCallId: "goose_9",
        },
      ]);
    });

    it("links across turns when the transcript is supplied", () => {
      const previousTurn = {
        content: [
          request(
            "goose_1",
            "delegate",
            { source: "Rivet", instructions: "Count files" },
            "completed",
          ),
          response("goose_1", "Started background task 20260807_72"),
        ],
      };
      const currentContent: MessageContent[] = [
        request("goose_5", "load", { source: "20260807_72" }, "completed"),
        response("goose_5", "42 files"),
      ];

      const entries = selectHarnessBrigade({
        content: currentContent,
        turnFinished: true,
        messages: [previousTurn, { content: currentContent }],
      });

      expect(entries).toEqual([
        {
          key: "goose_1",
          name: "Rivet",
          label: "Count files",
          status: "completed",
          latestToolCallId: "goose_5",
        },
      ]);
    });

    it("ignores a load of a named recipe, which is not a subagent", () => {
      expect(
        selectHarnessBrigade({
          content: [request("goose_3", "load", { source: "deep-research" })],
          turnFinished: false,
        }),
      ).toBe(NO_HARNESS_BRIGADE);
    });

    it("names a source-only delegate after its source", () => {
      const entries = selectHarnessBrigade({
        content: [request("goose_1", "delegate", { source: "Rivet" })],
        turnFinished: false,
      });

      expect(entries[0].name).toBe("Rivet");
      expect(entries[0].label).toBeUndefined();
    });
  });

  describe("Codex spawn_agent + wait_agent", () => {
    it("keeps the await on the spawned agent's chip", () => {
      const content: MessageContent[] = [
        request(
          "codex_1",
          "spawn_agent",
          { task_name: "indexer", message: "Index the repo" },
          "completed",
        ),
        response("codex_1", "spawned"),
        request("codex_2", "wait_agent", { targets: ["indexer"] }),
      ];

      const entries = selectHarnessBrigade({ content, turnFinished: false });

      expect(entries).toEqual([
        {
          key: "codex_1",
          name: "indexer",
          label: "Index the repo",
          status: "running",
          latestToolCallId: "codex_2",
        },
      ]);
    });

    it("resolves the codex-acp wire shape and a multi-target await", () => {
      const content: MessageContent[] = [
        request(
          "codex_1",
          "spawn_agent",
          { receiverThreadIds: ["thread-a"], prompt: "Port the API" },
          "completed",
        ),
        request(
          "codex_2",
          "spawn_agent",
          { receiverThreadIds: ["thread-b"], prompt: "Port the UI" },
          "completed",
        ),
        request(
          "codex_3",
          "wait_agent",
          { receiverThreadIds: ["thread-a", "thread-b"] },
          "completed",
        ),
        response("codex_3", "both finished"),
      ];

      const entries = selectHarnessBrigade({ content, turnFinished: true });

      expect(
        entries.map((entry) => [entry.key, entry.name, entry.status]),
      ).toEqual([
        ["codex_1", "thread-a", "completed"],
        ["codex_2", "thread-b", "completed"],
      ]);
      expect(
        entries.every((entry) => entry.latestToolCallId === "codex_3"),
      ).toBe(true);
    });

    it("mints a chip per named target when the spawn is not in view", () => {
      const entries = selectHarnessBrigade({
        content: [
          request("codex_9", "wait_agent", { targets: ["alpha", "beta"] }),
        ],
        turnFinished: false,
      });

      expect(entries.map((entry) => entry.key)).toEqual([
        "codex_9:alpha",
        "codex_9:beta",
      ]);
    });

    it("routes a follow-up task back onto the spawned agent", () => {
      const entries = selectHarnessBrigade({
        content: [
          request(
            "codex_1",
            "spawn_agent",
            { task_name: "indexer", message: "Index the repo" },
            "completed",
          ),
          request("codex_2", "followup_task", {
            target: "indexer",
            message: "Also index docs/",
          }),
        ],
        turnFinished: false,
      });

      expect(entries).toHaveLength(1);
      expect(entries[0].key).toBe("codex_1");
      expect(entries[0].status).toBe("running");
      // The spawn's task survives a follow-up that knows a different one.
      expect(entries[0].label).toBe("Index the repo");
    });

    it("attaches a later spawn of the same name to its own chip", () => {
      const entries = selectHarnessBrigade({
        content: [
          request(
            "codex_1",
            "spawn_agent",
            { task_name: "worker", message: "First half" },
            "completed",
          ),
          request(
            "codex_2",
            "spawn_agent",
            { task_name: "worker", message: "Second half" },
            "completed",
          ),
          request("codex_3", "wait_agent", { targets: ["worker"] }),
        ],
        turnFinished: false,
      });

      expect(entries.map((entry) => [entry.key, entry.status])).toEqual([
        ["codex_1", "completed"],
        ["codex_2", "running"],
      ]);
    });
  });

  it("is pure: the same content always yields the same projection", () => {
    const content: MessageContent[] = [
      request(
        "goose_1",
        "delegate",
        { source: "Rivet", instructions: "Count files" },
        "completed",
      ),
      response("goose_1", "Started background task 20260807_72"),
      request("goose_2", "load", { source: "20260807_72" }),
    ];

    expect(selectHarnessBrigade({ content, turnFinished: false })).toEqual(
      selectHarnessBrigade({ content, turnFinished: false }),
    );
    expect(content).toHaveLength(3);
  });
});
