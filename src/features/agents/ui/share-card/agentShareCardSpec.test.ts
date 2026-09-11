import { describe, expect, it } from "vitest";
import { truncateAgentCardTitle } from "./agentShareCardSpec";

describe("agentShareCardSpec", () => {
  it("uses Distill branding for an empty title", () => {
    expect(truncateAgentCardTitle("  ")).toBe("DISTILL AGENT");
  });

  it("uppercases and bounds long titles", () => {
    const title = truncateAgentCardTitle(
      "a very long agent name that continues",
    );
    expect(title).toBe("A VERY LONG AGENT NAME TH…");
    expect(Array.from(title)).toHaveLength(26);
  });

  it("uses explicit casing independent of the host locale", () => {
    expect(truncateAgentCardTitle("mini", "en")).toBe("MINI");
  });
});
