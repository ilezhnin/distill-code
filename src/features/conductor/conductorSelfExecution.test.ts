import { describe, expect, it } from "vitest";

import type { MessageContent, ToolKind } from "@/shared/types/messages";

import {
  isMutatingToolKind,
  isReadOnlyShellCommand,
  toolCallCommandText,
  turnHasMutatingToolCall,
} from "./conductorSelfExecution";

function toolRequest(
  toolKind?: ToolKind,
  args: Record<string, unknown> = {},
): MessageContent {
  return {
    type: "toolRequest",
    id: "t1",
    name: "shell",
    arguments: args,
    status: "completed",
    ...(toolKind ? { toolKind } : {}),
  };
}

/** An `execute` call carrying a shell command, the way a bridge sends one. */
function shellCall(command: string): MessageContent {
  return toolRequest("execute", { command });
}

describe("isMutatingToolKind", () => {
  it("keeps looking at the world quiet", () => {
    for (const kind of [
      "read",
      "search",
      "think",
      "fetch",
      "switch_mode",
    ] as const) {
      expect(isMutatingToolKind(kind)).toBe(false);
    }
  });

  it("flags everything that can change state", () => {
    for (const kind of [
      "edit",
      "delete",
      "move",
      "execute",
      "other",
    ] as const) {
      expect(isMutatingToolKind(kind)).toBe(true);
    }
  });

  it("treats an unreported kind as mutating — the pre-tiering behaviour", () => {
    expect(isMutatingToolKind(undefined)).toBe(true);
  });

  it("keeps grok's off-spec `list` kind quiet", () => {
    // Not an ACP kind; the grok bridge reports `list_dir` with it, and the
    // handler's cast lets it through. A directory listing is a read.
    expect(isMutatingToolKind("list" as ToolKind)).toBe(false);
  });
});

/**
 * The second half of the cry-wolf fix. `execute` is the kind a shell arrives
 * under whether it is reading or writing, and on a harness whose only way to
 * look at a repository is a shell, tiering by kind alone put the badge back on
 * every investigative turn — including the one where the conductor read the
 * docs and the git log to answer a question, exactly as the protocol asks.
 */
describe("isReadOnlyShellCommand", () => {
  it("clears the exact command that raised the false badge in the field", () => {
    // Lifted from the grok session behind the report: a PowerShell line of
    // git reads and separators, sent as one `execute` call, was branded as the
    // conductor doing the work itself.
    expect(
      isReadOnlyShellCommand(
        "git log --oneline -30; Write-Host '---'; git status -sb; Write-Host '---'; git log -1 --format='%h %ci %s'",
      ),
    ).toBe(true);
  });

  it("clears the commands a conductor investigates with", () => {
    for (const command of [
      "git log --oneline -20",
      "git -C /repo status --short",
      "git diff HEAD~1",
      "cat docs/PLAYBOOK.md",
      "rg -n 'Fallback' src",
      "ls -la src/features",
      "sed -n '1,80p' src/app.ts",
      "find . -name '*.ts'",
      "cat tasks/open/debt.md | head -40",
      "Get-Content .\\docs\\PLAYBOOK.md",
      "Select-String -Pattern Fallback -Path src\\*.cs",
    ]) {
      expect(isReadOnlyShellCommand(command)).toBe(true);
    }
  });

  it("keeps the badge on everything that writes", () => {
    for (const command of [
      "git commit -m 'wip'",
      "git checkout -b fix/tails",
      "git config user.name someone",
      "npm test",
      "cargo build",
      "sed -i 's/a/b/' file.ts",
      "find . -name '*.tmp' -delete",
      "find . -name '*.ts' -exec rm {} ;",
      "fd -x rm",
      "rg --pre=./decrypt pattern",
      "rm -rf build",
      "echo hi > file.txt",
      "cat file | tee copy.txt",
    ]) {
      expect(isReadOnlyShellCommand(command)).toBe(false);
    }
  });

  it("refuses to reason about a command that can hide one", () => {
    // A redirect, a substitution or a subshell can put a write behind a name
    // that reads as harmless, and no allowlist sees through them.
    for (const command of [
      "cat $(cat which-file)",
      "cat `cat which-file`",
      "(cd src && rm x)",
      "cat a > b",
      "",
    ]) {
      expect(isReadOnlyShellCommand(command)).toBe(false);
    }
  });

  it("does not split an operator that is inside quotes", () => {
    expect(isReadOnlyShellCommand("rg -n 'foo|bar' src")).toBe(true);
    expect(isReadOnlyShellCommand('grep "a;b" file')).toBe(true);
  });

  it("judges every segment of a chain, not just the first", () => {
    expect(isReadOnlyShellCommand("git log | head -5")).toBe(true);
    expect(isReadOnlyShellCommand("cat a.txt && rm a.txt")).toBe(false);
  });
});

describe("toolCallCommandText", () => {
  it("reads the command a bridge passes as a string", () => {
    expect(toolCallCommandText({ command: "git log" })).toBe("git log");
  });

  it("unwraps an argv array that is a shell running a script", () => {
    expect(toolCallCommandText({ command: ["bash", "-lc", "git log"] })).toBe(
      "git log",
    );
  });

  it("joins a plain argv array back into a line", () => {
    expect(toolCallCommandText({ command: ["cat", "README.md"] })).toBe(
      "cat README.md",
    );
  });

  it("finds nothing when no argument holds a command", () => {
    expect(toolCallCommandText({ path: "README.md" })).toBeNull();
    expect(toolCallCommandText(undefined)).toBeNull();
  });
});

describe("turnHasMutatingToolCall", () => {
  it("flags a turn that ran a state-changing tool", () => {
    expect(
      turnHasMutatingToolCall([
        { type: "text", text: "on it" },
        shellCall("rm -rf build"),
      ]),
    ).toBe(true);
  });

  it("stays quiet on a shell that only reads — the second cry-wolf fix", () => {
    expect(
      turnHasMutatingToolCall([
        shellCall("git log --oneline -20"),
        shellCall("cat docs/PLAYBOOK.md"),
        { type: "text", text: "here is what the project has done" },
      ]),
    ).toBe(false);
  });

  it("still flags an execute call whose command it cannot read", () => {
    // No command argument, so there is nothing to be lenient about.
    expect(turnHasMutatingToolCall([toolRequest("execute")])).toBe(true);
  });

  it("stays quiet on read-only exploration — the cry-wolf fix", () => {
    expect(
      turnHasMutatingToolCall([
        toolRequest("read"),
        toolRequest("search"),
        { type: "text", text: "the answer, from what I read" },
      ]),
    ).toBe(false);
  });

  it("flags a mixed turn: one mutation among any number of reads", () => {
    expect(
      turnHasMutatingToolCall([
        toolRequest("read"),
        toolRequest("edit"),
        toolRequest("search"),
      ]),
    ).toBe(true);
  });

  it("still flags a tool call whose harness reported no kind", () => {
    expect(turnHasMutatingToolCall([toolRequest()])).toBe(true);
  });

  it("leaves a plan-or-answer turn alone", () => {
    expect(
      turnHasMutatingToolCall([
        { type: "text", text: '```distill-wave\n{"steps":[]}\n```' },
        { type: "thinking", text: "hmm" },
      ]),
    ).toBe(false);
  });

  it("is safe on an empty or missing turn", () => {
    expect(turnHasMutatingToolCall([])).toBe(false);
    expect(turnHasMutatingToolCall(undefined)).toBe(false);
  });
});
