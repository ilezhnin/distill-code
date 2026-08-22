import { describe, expect, it } from "vitest";
import type { Message } from "@/shared/types/messages";
import { userMessagesNeedingOrchestrator } from "./userMessagesNeedingOrchestrator";

function userMessage(
  id: string,
  text: string,
  metadata?: Message["metadata"],
): Message {
  return {
    id,
    role: "user",
    created: 1,
    content: [{ type: "text", text }],
    metadata,
  };
}

describe("userMessagesNeedingOrchestrator", () => {
  it("returns new operator messages that do not already have an orchestrator", () => {
    const needed = userMessagesNeedingOrchestrator({
      messages: [
        userMessage("old", "already loaded"),
        userMessage("new", "ship the login flow"),
      ],
      hydratedUserMessageIds: new Set(["old"]),
      childAnchorMessageIds: new Set(),
    });

    expect(needed.map((message) => message.id)).toEqual(["new"]);
  });

  it("skips steered and cross-session user messages", () => {
    const needed = userMessagesNeedingOrchestrator({
      messages: [
        userMessage("steer", "keep going", { delivery: "steer" }),
        userMessage("cross", "from child", {
          origin: "berdctl_cross_session",
        }),
      ],
      hydratedUserMessageIds: new Set(),
      childAnchorMessageIds: new Set(),
    });

    expect(needed).toEqual([]);
  });
});
