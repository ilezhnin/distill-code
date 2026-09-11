import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";

const mocks = vi.hoisted(() => ({
  appShellRender: vi.fn(),
  securityConfirmationFallbackRender: vi.fn(),
}));

vi.mock("@/app/AppShell", () => ({
  AppShell: () => {
    mocks.appShellRender();
    return "App Shell";
  },
}));

vi.mock("@/app/ui/SelectedTextContextMenu", () => ({
  SelectedTextContextMenu: () => null,
}));

vi.mock("@/features/security/ui/SecurityConfirmationPanel", () => ({
  SecurityConfirmationFallback: () => {
    mocks.securityConfirmationFallbackRender();
    return null;
  },
}));

vi.mock("@/shared/ui/sonner", () => ({
  Toaster: () => null,
}));

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("__TAURI_INTERNALS__", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderApp() {
    return render(
      <ThemeProvider>
        <App />
      </ThemeProvider>,
    );
  }

  it("prevents default window navigation when files are dragged into the app", () => {
    renderApp();

    const dragover = new Event("dragover", { cancelable: true });
    window.dispatchEvent(dragover);
    expect(dragover.defaultPrevented).toBe(true);

    const drop = new Event("drop", { cancelable: true });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
  });

  it("mounts the app shell and the security confirmation fallback", () => {
    renderApp();

    expect(screen.getByText("App Shell")).toBeInTheDocument();
    expect(mocks.appShellRender).toHaveBeenCalled();
    expect(mocks.securityConfirmationFallbackRender).toHaveBeenCalled();
  });
});
