import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getFlockRoot: vi.fn(),
  setFlockRoot: vi.fn(),
  open: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/shared/api/flockStore", () => ({
  getFlockRoot: mocks.getFlockRoot,
  setFlockRoot: mocks.setFlockRoot,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { renderWithProviders } from "@/test/render";

import { FlockFolderRow } from "../FlockFolderRow";

describe("FlockFolderRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFlockRoot.mockResolvedValue({
      root: "C:\\Users\\Example\\.distill",
      forcedByEnvironment: false,
    });
  });

  it("records a new folder and says a restart is needed", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("D:\\distill");
    mocks.setFlockRoot.mockResolvedValue(undefined);
    renderWithProviders(<FlockFolderRow />);

    await user.click(await screen.findByRole("button", { name: /Change/ }));

    expect(mocks.setFlockRoot).toHaveBeenCalledWith("D:\\distill");
    expect(screen.getByTestId("flock-folder-path")).toHaveTextContent(
      "D:\\distill",
    );
    expect(screen.getByTestId("flock-folder-restart")).toBeInTheDocument();
  });

  it("keeps showing the old folder when the new one is refused", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("Z:\\read-only");
    mocks.setFlockRoot.mockRejectedValue(new Error("not writable"));
    renderWithProviders(<FlockFolderRow />);

    await user.click(await screen.findByRole("button", { name: /Change/ }));

    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.getByTestId("flock-folder-path")).toHaveTextContent(
      "C:\\Users\\Example\\.distill",
    );
  });
});
