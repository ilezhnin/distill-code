import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../ThemeProvider";

function blockDomStorage() {
  // What WebView2 does when DOM storage is disabled by policy or the storage
  // database is unreadable.
  const securityError = new Error("SecurityError");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw securityError;
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw securityError;
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw securityError;
  });
}

describe("ThemeProvider with blocked storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove("light", "dark");
  });

  it("still renders the app and applies a theme", () => {
    blockDomStorage();

    render(
      <ThemeProvider>
        <p>app</p>
      </ThemeProvider>,
    );

    expect(screen.getByText("app")).toBeInTheDocument();
    expect(
      document.documentElement.classList.contains("light") ||
        document.documentElement.classList.contains("dark"),
    ).toBe(true);
  });
});
