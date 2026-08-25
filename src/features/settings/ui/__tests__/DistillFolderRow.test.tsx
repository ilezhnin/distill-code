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
      holdsEverything: true,
      legacyDataDir: null,
    });
  });

  it("shows where everything currently lives", async () => {
    renderWithProviders(<DistillFolderRow />);

    expect(await screen.findByTestId("distill-folder-path")).toHaveTextContent(
      "C:\\Users\\User\\.distill",
    );
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

  it("changes nothing when the picker is dismissed", async () => {
    const user = userEvent.setup();
    mocks.open.mockResolvedValue(null);
    renderWithProviders(<DistillFolderRow />);

    await user.click(await screen.findByRole("button", { name: /Change/ }));

    expect(mocks.setDistillRoot).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("distill-folder-restart"),
    ).not.toBeInTheDocument();
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

  it("says so when an environment variable is in charge instead", async () => {
    // Offering a picker that cannot win would have the operator changing a
    // value that does nothing.
    mocks.getDistillRoot.mockResolvedValue({
      root: "/tmp/forced",
      forcedByEnvironment: true,
      holdsEverything: true,
      legacyDataDir: null,
    });
    renderWithProviders(<DistillFolderRow />);

    expect(await screen.findByTestId("distill-folder-forced")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says where the chats still are when they have not moved", async () => {
    // Otherwise the row reads "everything lives here" while the operator's
    // history sits somewhere else entirely.
    mocks.getDistillRoot.mockResolvedValue({
      root: "C:\\Users\\User\\.distill",
      forcedByEnvironment: false,
      holdsEverything: false,
      legacyDataDir: "C:\\Users\\User\\AppData\\Roaming\\Block\\goose\\data",
    });
    renderWithProviders(<DistillFolderRow />);

    expect(
      await screen.findByTestId("distill-folder-legacy"),
    ).toHaveTextContent("Block");
  });

  it("renders nothing outside the desktop app", async () => {
    mocks.getDistillRoot.mockResolvedValue(null);
    const { container } = renderWithProviders(<DistillFolderRow />);
    expect(container).toBeEmptyDOMElement();
  });
});
