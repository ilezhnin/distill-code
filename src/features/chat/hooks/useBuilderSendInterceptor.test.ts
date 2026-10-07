import { describe, expect, it } from "vitest";
import { composeBuilderSendOptions } from "./useBuilderSendInterceptor";

describe("agent editor send instructions", () => {
  it("provides the public file contract and preserves the bound draft", () => {
    const options = composeBuilderSendOptions(
      {
        intent: "build-agent",
        agentBuilderOpen: true,
        targetAgentPath: "/work/example-agent.md",
      },
      { assistantPrompt: "Keep the user's chosen tone." },
    );
    expect(options.assistantPrompt).toContain("YAML frontmatter");
    expect(options.assistantPrompt).toContain(
      "Edit exactly this file: /work/example-agent.md",
    );
    expect(options.assistantPrompt).toContain("draft and builderSessionId");
    expect(options.assistantPrompt).toContain("Keep the user's chosen tone.");
  });

  it("repeats draft ownership without repeating the static file contract", () => {
    const session = {
      intent: "build-agent" as const,
      agentBuilderOpen: true,
      targetAgentPath: "/work/another-example.md",
    };
    composeBuilderSendOptions(session);
    const next = composeBuilderSendOptions(session);
    expect(next.assistantPrompt).not.toContain("YAML frontmatter");
    expect(next.assistantPrompt).toContain(session.targetAgentPath);
  });

  it("does not alter sends after the editor has closed", () => {
    const options = { assistantPrompt: "Ordinary chat instructions." };
    expect(
      composeBuilderSendOptions(
        {
          intent: "build-agent",
          agentBuilderOpen: false,
          targetAgentPath: "/work/closed-example.md",
        },
        options,
      ),
    ).toBe(options);
  });
});
