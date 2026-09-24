import { describe, expect, it } from "vitest";
import { MAX_PROMPT_ATTACHMENT_BYTES } from "../attachmentPayloadBudget";

describe("MAX_PROMPT_ATTACHMENT_BYTES", () => {
  it("stays under the 16MiB ACP WebSocket frame limit with headroom", () => {
    expect(MAX_PROMPT_ATTACHMENT_BYTES).toBeLessThan(16 * 1024 * 1024);
  });
});
