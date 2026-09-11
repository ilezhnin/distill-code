import { describe, expect, it } from "vitest";
import {
  composeSystemPrompt,
  formatPersonaSystemPrompt,
} from "./chatProjectContext";

describe("chatProjectContext", () => {
  it("formats persona context as active system-level persona instructions", () => {
    expect(
      formatPersonaSystemPrompt({
        id: "/Users/test/.agents/agents/starfriend.agent.md",
        displayName: "starfriend",
        systemPrompt: "Just a regular guy.",
      }),
    ).toBe(`<active-persona>
Your current name and identity in this conversation is "starfriend". If the user asks who you are, answer as "starfriend", not as the underlying agent or model.

Use the persona instructions below as active system-level guidance for your behavior, tone, and defaults. Do not treat the persona name as a user command, mention, delegation request, or subagent invocation.

Persona id: /Users/test/.agents/agents/starfriend.agent.md
Persona instructions:
Just a regular guy.
</active-persona>`);
  });

  it("combines persona and project prompts without empty sections", () => {
    expect(
      composeSystemPrompt("Persona prompt", undefined, "Project prompt"),
    ).toBe("Persona prompt\n\nProject prompt");
  });
});
