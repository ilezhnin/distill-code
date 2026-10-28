import { act, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockInstallRendererDiagnostics = vi.hoisted(() => vi.fn());
const mockReportRendererError = vi.hoisted(() => vi.fn());
const mockInvoke = vi.hoisted(() => vi.fn());
const mockShowMainWindow = vi.hoisted(() => vi.fn());

vi.mock("@/app/lib/showMainWindow", () => ({
  showMainWindow: mockShowMainWindow,
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));
vi.mock("@/shared/styles/globals.css", () => ({}));

vi.mock("@/app/App", () => ({
  App: () => <div data-testid="main-app" />,
}));

vi.mock("@/app/RendererBootLog", () => ({
  RendererBootLog: () => null,
}));

vi.mock("@/app/ui/StartupLoadingView", () => ({
  StartupLoadingView: () => <div data-testid="startup-loading" />,
}));

vi.mock("@/app/lib/rendererDiagnostics", () => ({
  installRendererDiagnostics: mockInstallRendererDiagnostics,
  reportRendererError: mockReportRendererError,
}));

vi.mock("@/app/ui/RendererErrorBoundary", () => ({
  RendererErrorBoundary: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/features/updates/hooks/useUpdater", () => ({
  UpdaterProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/shared/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mockInvoke }));

vi.mock("@/shared/theme/ThemeProvider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

async function loadMainAt(search: string) {
  window.history.replaceState({}, "", `/${search}`);
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await (await import("./main")).startup;
  });
}

describe("main entrypoint telemetry startup", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockInvoke.mockResolvedValue("fresh-with-landing-v1");
    globalThis.fetch = vi.fn() as typeof globalThis.fetch;
  });

  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.clear();
    sessionStorage.clear();
    vi.doUnmock("@/app/renderRoot");
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the main app without native boot work or telemetry traffic", async () => {
    sessionStorage.setItem("flock:startup-module-retry", "1");
    await loadMainAt("");

    await screen.findByTestId("main-app");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(mockInstallRendererDiagnostics).toHaveBeenCalledWith({
      windowKind: "main",
    });
    expect(sessionStorage.getItem("flock:startup-module-retry")).toBeNull();
  });

  it("reveals a recovery window when the renderer module cannot load", async () => {
    const error = new TypeError(
      "Failed to fetch dynamically imported module: invented-renderer",
    );
    sessionStorage.setItem("flock:startup-module-retry", "1");
    vi.doMock("@/app/renderRoot", () => ({
      get renderApp() {
        throw error;
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await loadMainAt("");
    expect(screen.getByRole("alert")).toHaveTextContent(error.message);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(mockShowMainWindow).toHaveBeenCalledOnce();
  });
});
