import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArtifactViewerPanel } from "../ArtifactViewerPanel";
import { useArtifactViewerStore } from "../../stores/artifactViewerStore";

const mockReadTextFile = vi.fn();

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: () => null,
    pathExists: vi.fn().mockResolvedValue(true),
    openResolvedPath: vi.fn().mockResolvedValue(undefined),
    openInApp: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("@/shared/api/system", () => ({
  readTextFile: (path: string) => mockReadTextFile(path),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
}));

function resetStore() {
  useArtifactViewerStore.setState({
    tabsBySession: {},
    activePathBySession: {},
    openBySession: {},
    lastClosedPathBySession: {},
  });
}

describe("ArtifactViewerPanel tabs", () => {
  beforeEach(() => {
    resetStore();
    mockReadTextFile.mockResolvedValue({
      contents: "hello",
      truncated: false,
    });
  });

  afterEach(resetStore);

  it("opens files as tabs and closes the active tab without dropping the others", async () => {
    const { open } = useArtifactViewerStore.getState();
    open("s1", { resolvedPath: "/p/a.ts", filename: "a.ts" });
    open("s1", { resolvedPath: "/p/b.ts", filename: "b.ts" });

    render(<ArtifactViewerPanel sessionId="s1" />);

    expect(screen.getByRole("tab", { name: "a.ts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "b.ts" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "b.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Close b.ts" }));

    expect(screen.queryByRole("tab", { name: "b.ts" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "a.ts" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("offers a show-chat control when the conversation is collapsed", () => {
    useArtifactViewerStore.getState().open("s1", {
      resolvedPath: "/p/a.ts",
      filename: "a.ts",
    });
    const onToggleChat = vi.fn();

    render(
      <ArtifactViewerPanel
        sessionId="s1"
        chatCollapsed
        onToggleChat={onToggleChat}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Show chat" }),
    ).toBeInTheDocument();
  });
});
