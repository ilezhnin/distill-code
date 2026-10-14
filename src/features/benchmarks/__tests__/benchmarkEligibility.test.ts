import { describe, expect, it } from "vitest";
import { authoredByCandidate } from "../lib/benchmarkEligibility";

describe("authoredByCandidate", () => {
  const author = {
    providerId: "codex-acp",
    modelId: "gpt-6-astra",
    effort: "xhigh",
  };
  it("requires the same provider, model and effort", () => {
    const environment = { authoredBy: [author] };
    expect(authoredByCandidate(environment, author)).toBe(true);
    for (const candidate of [
      { ...author, modelId: "gpt-5.6-luna", effort: "low" },
      { ...author, effort: "low" },
      { ...author, providerId: "other-provider" },
      { ...author, modelId: "gpt-6-astra-preview" },
      { ...author, effort: null },
    ])
      expect(authoredByCandidate(environment, candidate)).toBe(false);
  });
  it("never treats legacy provider or model needles as exact identities", () => {
    expect(
      authoredByCandidate({ authoredBy: ["codex", "gpt-6"] }, author),
    ).toBe(false);
    expect(
      authoredByCandidate(
        {
          authoredBy: [
            { providerId: author.providerId, modelId: author.modelId },
          ],
        },
        author,
      ),
    ).toBe(false);
  });
  it("matches null effort only to null effort", () => {
    const noReasoning = { ...author, effort: null };
    expect(
      authoredByCandidate({ authoredBy: [noReasoning] }, noReasoning),
    ).toBe(true);
    expect(authoredByCandidate({ authoredBy: [noReasoning] }, author)).toBe(
      false,
    );
  });
  it("treats a declared alias as the model it stands for", () => {
    const environment = {
      authoredBy: [
        { providerId: "claude-acp", modelId: "opus[1m]", effort: "xhigh" },
      ],
    };
    expect(
      authoredByCandidate(environment, {
        providerId: "claude-acp",
        modelId: "default",
        effort: "xhigh",
      }),
    ).toBe(true);
    expect(
      authoredByCandidate(environment, {
        providerId: "claude-acp",
        modelId: "sonnet",
        effort: "xhigh",
      }),
    ).toBe(false);
    expect(
      authoredByCandidate(environment, {
        providerId: "claude-acp",
        modelId: "default",
        effort: "low",
      }),
    ).toBe(false);
  });
});
