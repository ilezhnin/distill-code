import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationAnatomyPage } from "./ConversationAnatomyPage";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string, scheme?: string) =>
    `${scheme ?? "asset"}://${path}`,
  invoke: vi.fn().mockResolvedValue(undefined),
}));

describe("ConversationAnatomyPage", () => {
  it("shows the worker chat's header, its report and the brigade chips", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ConversationAnatomyPage />
      </QueryClientProvider>,
    );

    // The header over the brief, with the way back to the chat that sent it.
    expect(screen.getAllByText("Scout · waveEngine").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("button", { name: "Started by Producer" }).length,
    ).toBeGreaterThan(0);

    // The report fence drawn as the report, never as JSON.
    expect(await screen.findByText("Report · completed")).toBeInTheDocument();
    expect(screen.getByText("Report · blocked")).toBeInTheDocument();
    expect(screen.queryByText(/"needsOperator"/)).not.toBeInTheDocument();

    // The chips, with what each worker is doing or why it stopped.
    const chips = screen.getAllByTestId("brigade-chip");
    expect(chips.length).toBeGreaterThanOrEqual(5);
    expect(
      screen.getByText("· 12.3k · 7 tools · Reading waveEngine.ts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("· Agent process exited unexpectedly (exit code 1)."),
    ).toBeInTheDocument();
  });
});
