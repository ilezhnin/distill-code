import { beforeEach, describe, expect, it, vi } from "vitest";
import { resendUnansweredMessage } from "./unansweredSend";

const mocks = vi.hoisted(() => ({
  sendPromptToExistingSessionInBackground: vi.fn(),
}));

vi.mock("@/features/distillctl/commands/runtime/sessionSend", () => ({
  sendPromptToExistingSessionInBackground: (...args: unknown[]) =>
    mocks.sendPromptToExistingSessionInBackground(...args),
}));

describe("resendUnansweredMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sendPromptToExistingSessionInBackground.mockResolvedValue(undefined);
  });

  // The resend button reaches the agent through the sender distillctl uses, whose
  // defaults stamp the message as a delivery from another chat — so the
  // operator's own re-sent words rendered, forever, as somebody else's.
  it("does not send the operator's own message as a distillctl delivery", () => {
    resendUnansweredMessage("session-1", "  do the thing  ");

    expect(mocks.sendPromptToExistingSessionInBackground).toHaveBeenCalledWith(
      "session-1",
      "do the thing",
      undefined,
      { sendOptions: {} },
    );
    const options = mocks.sendPromptToExistingSessionInBackground.mock
      .calls[0]?.[3] as { sendOptions?: Record<string, unknown> };
    expect(options.sendOptions).toBeDefined();
    expect(JSON.stringify(options.sendOptions)).not.toContain(
      "distillctl_cross_session",
    );
  });
});
