import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SessionNode } from "../types";
import { BrigadeWaitIndicator } from "./BrigadeWaitIndicator";

function node(
  sessionId: string,
  status: SessionNode["status"],
  overrides: Partial<SessionNode> = {},
): SessionNode {
  return {
    sessionId,
    projectId: "project",
    role: "worker",
    managedBy: "ui",
    parentSessionId: "conductor-1",
    rootConductorId: "conductor-1",
    runId: null,
    harnessId: "goose",
    displayName: sessionId,
    status,
    ...overrides,
  };
}

describe("BrigadeWaitIndicator", () => {
  it("announces the working count while the chat is idle", () => {
    render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[
          node("a", "running"),
          node("b", "waiting", { managedBy: "wave" }),
          node("c", "completed"),
        ]}
      />,
    );

    const indicator = screen.getByTestId("brigade-wait-indicator");
    expect(indicator).toHaveAttribute("role", "status");
    expect(indicator).toHaveTextContent("2 executors are working");
  });

  it("uses the singular form for a single child", () => {
    render(
      <BrigadeWaitIndicator chatState="idle" nodes={[node("a", "starting")]} />,
    );

    expect(screen.getByTestId("brigade-wait-indicator")).toHaveTextContent(
      "1 executor is working",
    );
  });

  it("renders nothing while the chat itself is streaming", () => {
    const { container } = render(
      <BrigadeWaitIndicator
        chatState="streaming"
        nodes={[node("a", "running")]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing once every child is terminal", () => {
    const { container } = render(
      <BrigadeWaitIndicator
        chatState="idle"
        nodes={[node("a", "completed"), node("b", "stopped")]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without children", () => {
    const { container } = render(
      <BrigadeWaitIndicator chatState="idle" nodes={[]} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
