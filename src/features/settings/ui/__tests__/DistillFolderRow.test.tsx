import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDistillRoot: vi.fn(),
  setDistillRoot: vi.fn(),
  open: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/shared/api/distillStore", () => ({
  getDistillRoot: mocks.getDistillRoot,
  setDistillRoot: mocks.setDistillRoot,
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { renderWithProviders } from "@/test/render";

import { DistillFolderRow } from "../DistillFolderRow";

describe("DistillFolderRow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDistillRoot.mockResolvedValue({
      root: "C:\\Users\\User\\.distill",
      forcedByEnvironment: false,
    });
  });

  it("records a new folder and says a restart is needed", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("D:\\distill");
    mocks.setDistillRoot.mockResolvedValue(undefined);
    renderWithProviders(<DistillFolderRow />);

    await user.click(await screen.findByRole("button", { name: /Change/ }));

    expect(mocks.setDistillRoot).toHaveBeenCalledWith("D:\\distill");
    expect(screen.getByTestId("distill-folder-path")).toHaveTextContent(
      "D:\\distill",
    );
    expect(screen.getByTestId("distill-folder-restart")).toBeInTheDocument();
  });

  it("keeps showing the old folder when the new one is refused", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue("Z:\\read-only");
    mocks.setDistillRoot.mockRejectedValue(new Error("not writable"));
    renderWithProviders(<DistillFolderRow />);

    await user.click(await screen.findByRole("button", { name: /Change/ }));

    expect(mocks.toastError).toHaveBeenCalled();
    expect(screen.getByTestId("distill-folder-path")).toHaveTextContent(
      "C:\\Users\\User\\.distill",
    );
  });
});
