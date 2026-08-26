import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderWithProviders } from "@/test/render";
import type { Persona } from "@/shared/types/agents";

import { AgentPermissionsSummary } from "../AgentPermissionsSummary";

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "p1",
    displayName: "Custom Helper",
    systemPrompt: "Help.",
    isBuiltin: false,
    writable: true,
    ...overrides,
  };
}

describe("AgentPermissionsSummary", () => {
  it("shows the layer defaults, named as inherited, when nothing is set", () => {
    renderWithProviders(<AgentPermissionsSummary persona={makePersona()} />);

    // Not "no permissions": an agent with no override still starts whatever
    // its layer allows, and the page has to say which.
    const spawns = screen.getByTestId("agent-permissions-summary-spawns");
    expect(spawns).toHaveTextContent("conductor: orchestrators, workers");
    expect(spawns).toHaveTextContent("worker: nothing");
    expect(
      screen.getByTestId("agent-permissions-summary-spawns-note"),
    ).toHaveTextContent("From its role");

    const memory = screen.getByTestId("agent-permissions-summary-memory");
    expect(memory).toHaveTextContent("orchestrator: needs this grant");
    expect(
      screen.getByTestId("agent-permissions-summary-memory-note"),
    ).toHaveTextContent("From its role");
  });

  it("shows an explicit spawn list as set on the agent", () => {
    renderWithProviders(
      <AgentPermissionsSummary persona={makePersona({ spawns: ["worker"] })} />,
    );

    expect(
      screen.getByTestId("agent-permissions-summary-spawns"),
    ).toHaveTextContent("workers");
    expect(
      screen.getByTestId("agent-permissions-summary-spawns-note"),
    ).toHaveTextContent("Set on this agent");
    // The other row is untouched by the spawn override.
    expect(
      screen.getByTestId("agent-permissions-summary-memory-note"),
    ).toHaveTextContent("From its role");
  });

  it("reads an empty override as starting nothing, not as unset", () => {
    renderWithProviders(
      <AgentPermissionsSummary persona={makePersona({ spawns: [] })} />,
    );

    const spawns = screen.getByTestId("agent-permissions-summary-spawns");
    expect(spawns).toHaveTextContent("nothing");
    expect(spawns).not.toHaveTextContent("conductor:");
    expect(
      screen.getByTestId("agent-permissions-summary-spawns-note"),
    ).toHaveTextContent("Set on this agent");
  });

  it("states an explicit memory grant and what it buys", () => {
    renderWithProviders(
      <AgentPermissionsSummary persona={makePersona({ memoryWrite: true })} />,
    );

    expect(
      screen.getByTestId("agent-permissions-summary-memory"),
    ).toHaveTextContent("as an orchestrator");
    expect(
      screen.getByTestId("agent-permissions-summary-memory-note"),
    ).toHaveTextContent("Set on this agent");
  });

  it("states an explicit refusal instead of showing the role default", () => {
    renderWithProviders(
      <AgentPermissionsSummary persona={makePersona({ memoryWrite: false })} />,
    );

    const memory = screen.getByTestId("agent-permissions-summary-memory");
    expect(memory).toHaveTextContent("No memory-write grant");
    expect(memory).not.toHaveTextContent("conductor: writes");
  });
});
