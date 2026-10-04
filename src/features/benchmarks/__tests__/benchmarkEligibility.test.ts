import { describe, expect, it } from "vitest";
import { authoredByCandidate } from "../lib/benchmarkEligibility";

describe("authoredByCandidate", () => {
  it("treats a declared alias as the model it stands for", () => {
    const environment = { authoredBy: ["opus"] };
    expect(
      authoredByCandidate(environment, {
        providerId: "claude-acp",
        modelId: "default",
      }),
    ).toBe(true);
    expect(
      authoredByCandidate(environment, {
        providerId: "claude-acp",
        modelId: "sonnet",
      }),
    ).toBe(false);
  });
});
