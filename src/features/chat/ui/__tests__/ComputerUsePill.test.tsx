import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComputerUsePill } from "../ComputerUsePill";

const { readComputerUse, setComputerUse, toastError } = vi.hoisted(() => ({
  readComputerUse: vi.fn(),
  setComputerUse: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/shared/api/acpApi", () => ({ readComputerUse, setComputerUse }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

beforeEach(() => {
  readComputerUse.mockResolvedValue({ enabled: false, driverVersion: "9.9.9" });
  setComputerUse.mockImplementation(
    async (_sessionId: string, enabled: boolean) => ({
      enabled,
      driverVersion: "9.9.9",
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ComputerUsePill", () => {
  it("shows nothing until the chat has a session the host answers for", async () => {
    const { rerender } = render(<ComputerUsePill />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(readComputerUse).not.toHaveBeenCalled();

    readComputerUse.mockRejectedValueOnce(new Error("Method not found"));
    rerender(<ComputerUsePill sessionId="chat-1" />);
    await waitFor(() => expect(readComputerUse).toHaveBeenCalledWith("chat-1"));
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("starts off and turns on with the host's answer", async () => {
    const user = userEvent.setup();
    render(<ComputerUsePill sessionId="chat-1" />);
    const pill = await screen.findByRole("button", { name: /Computer/ });
    expect(pill).toHaveAttribute("aria-pressed", "false");

    await user.click(pill);
    expect(setComputerUse).toHaveBeenCalledWith("chat-1", true);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Computer/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });

  it("keeps the stored state and says why when the host refuses", async () => {
    const user = userEvent.setup();
    setComputerUse.mockRejectedValueOnce(
      new Error("Could not download the computer use driver: offline"),
    );
    render(<ComputerUsePill sessionId="chat-1" />);
    await user.click(await screen.findByRole("button", { name: /Computer/ }));

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError.mock.calls[0][0]).toBe("Could not turn computer use on");
    expect(screen.getByRole("button", { name: /Computer/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("does not change while a turn runs", async () => {
    const user = userEvent.setup();
    readComputerUse.mockResolvedValueOnce({
      enabled: true,
      driverVersion: "9.9.9",
    });
    render(<ComputerUsePill sessionId="chat-1" runActive />);
    const pill = await screen.findByRole("button", { name: /Computer/ });
    expect(pill).toHaveAttribute("aria-pressed", "true");
    expect(pill).toHaveAttribute("aria-disabled", "true");

    await user.click(pill);
    expect(setComputerUse).not.toHaveBeenCalled();
  });
});
