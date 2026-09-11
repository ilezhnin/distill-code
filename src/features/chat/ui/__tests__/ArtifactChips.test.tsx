import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactChips } from "../ArtifactChips";

const mockOpenInApp = vi.fn().mockResolvedValue(undefined);
const mockOpenResolvedPath = vi.fn().mockResolvedValue(undefined);
const mockToastError = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: { error: mockToastError },
}));

vi.mock("@/features/chat/hooks/ArtifactPolicyContext", () => ({
  useArtifactActionsContext: () => ({
    resolveMarkdownHref: () => null,
    pathExists: vi.fn().mockResolvedValue(true),
    openResolvedPath: mockOpenResolvedPath,
    openInApp: mockOpenInApp,
  }),
}));

function target(path: string) {
  return { path, filename: path.split("/").pop() ?? path };
}

describe("ArtifactChips", () => {
  beforeEach(() => {
    mockOpenInApp.mockClear();
    mockOpenResolvedPath.mockClear();
    mockToastError.mockClear();
  });

  it("opens the file in the viewer when clicked", async () => {
    const user = userEvent.setup();
    render(<ArtifactChips artifacts={[target("/p/report.md")]} />);

    await user.click(screen.getByRole("button", { name: /open report\.md/i }));
    expect(mockOpenInApp).toHaveBeenCalledWith("/p/report.md", "report.md");
  });

  it("reports a chip whose file can no longer be opened", async () => {
    const user = userEvent.setup();
    mockOpenInApp.mockRejectedValueOnce(new Error("File not found"));
    render(<ArtifactChips artifacts={[target("/p/gone.md")]} />);

    await user.click(screen.getByRole("button", { name: /open gone\.md/i }));
    await vi.waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("gone.md"),
      );
    });
  });
});
