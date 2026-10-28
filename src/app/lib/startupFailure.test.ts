import { fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { showMainWindow } from "./showMainWindow";
import { clearStartupRetry, showStartupFailure } from "./startupFailure";

vi.mock("./showMainWindow", () => ({ showMainWindow: vi.fn() }));
vi.mock("@/shared/i18n/locale", () => ({ getInitialLocale: () => "en" }));

const reload = vi.fn();
beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  document.body.innerHTML = '<div id="root"></div>';
  vi.stubGlobal("window", { location: { reload } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  document.body.innerHTML = "";
});

it("retries a failed module once, then reveals recovery instead of looping invisibly", () => {
  const error = new TypeError(
    "Failed to fetch dynamically imported module: invented-module",
  );
  showStartupFailure(error);
  expect(reload).toHaveBeenCalledTimes(1);
  showStartupFailure(error);
  expect(reload).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert")).toHaveTextContent(error.message);
  expect(showMainWindow).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(reload).toHaveBeenCalledTimes(2);
});

it("shows configuration and code failures immediately without automatic reload", () => {
  showStartupFailure(new Error("Invented configuration failure"));
  expect(reload).not.toHaveBeenCalled();
  expect(showMainWindow).toHaveBeenCalledOnce();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Invented configuration failure",
  );
});

it("allows recovery from a later module failure after a successful startup", () => {
  const error = new TypeError(
    "Failed to fetch dynamically imported module: invented-module",
  );
  showStartupFailure(error);
  clearStartupRetry();
  showStartupFailure(error);
  expect(reload).toHaveBeenCalledTimes(2);
});
