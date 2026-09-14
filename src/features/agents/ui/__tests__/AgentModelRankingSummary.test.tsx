import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "@/test/render";

import { AgentModelRankingSummary } from "../AgentModelRankingSummary";

describe("AgentModelRankingSummary", () => {
  it("shows the role's built-in order for a bundled agent", () => {
    renderWithProviders(
      <AgentModelRankingSummary
        persona={{ displayName: "Producer", modelRanking: "" }}
      />,
    );
    expect(screen.getAllByTestId("agent-ranking-summary-row").length).toBe(3);
  });

  it("renders no preference for a name that is an Object.prototype member", () => {
    // "Constructor" slugged is `constructor`; the class table lookup used to
    // return Object.prototype.constructor and the page threw on `.ranking`.
    renderWithProviders(
      <AgentModelRankingSummary
        persona={{ displayName: "Constructor", modelRanking: "" }}
      />,
    );
    expect(screen.getByTestId("agent-ranking-summary-none")).toBeTruthy();
  });

  it("renders no preference for a frontmatter class named after a prototype member", () => {
    renderWithProviders(
      <AgentModelRankingSummary
        persona={{ displayName: "Helper", modelRanking: "constructor" }}
      />,
    );
    expect(screen.getByTestId("agent-ranking-summary-none")).toBeTruthy();
  });
});
