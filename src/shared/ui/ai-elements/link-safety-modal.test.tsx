import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LinkSafetyModal } from "./link-safety-modal";
import userEvent from "@testing-library/user-event";

afterEach(() => vi.restoreAllMocks());

it("keeps copy feedback visible and resets it for a different link", async () => {
  userEvent.setup();
  const writeText = vi
    .spyOn(navigator.clipboard, "writeText")
    .mockResolvedValue(undefined);
  const onClose = vi.fn();
  const { rerender } = render(
    <LinkSafetyModal isOpen onClose={onClose} url="https://one.example.test" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Copied!" })).toBeInTheDocument(),
  );
  expect(writeText).toHaveBeenCalledWith("https://one.example.test");
  rerender(
    <LinkSafetyModal isOpen onClose={onClose} url="https://two.example.test" />,
  );
  expect(screen.getByRole("button", { name: "Copy link" })).toBeInTheDocument();
});
