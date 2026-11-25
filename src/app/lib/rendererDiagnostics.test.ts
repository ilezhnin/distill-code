import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  writeDiagnosticEvent: vi.fn(async (_input: unknown) => undefined),
}));

vi.mock("@/shared/api/diagnostics", () => ({
  writeDiagnosticEvent: mocks.writeDiagnosticEvent,
}));

import { installRendererDiagnostics } from "./rendererDiagnostics";

// The exact notice Chromium dispatches when it defers a ResizeObserver
// notification to the next frame (as logged by the installed app).
const RESIZE_OBSERVER_NOTICE =
  "ResizeObserver loop completed with undelivered notifications.";

function dispatchWindowError(init: ErrorEventInit) {
  window.dispatchEvent(new ErrorEvent("error", init));
}

describe("renderer diagnostics: window errors", () => {
  let uninstall: () => void = () => {};

  beforeEach(() => {
    mocks.writeDiagnosticEvent.mockClear();
    uninstall = installRendererDiagnostics({ windowKind: "main" });
  });

  afterEach(() => {
    uninstall();
  });

  it("control: a real window error is still logged as an error", () => {
    dispatchWindowError({
      message: "Uncaught TypeError: boom",
      error: new TypeError("boom"),
      filename: "http://tauri.localhost/assets/index.js",
      lineno: 3,
      colno: 7,
    });
    dispatchWindowError({ message: "Script error.", error: null });

    expect(mocks.writeDiagnosticEvent).toHaveBeenCalledTimes(2);
    expect(mocks.writeDiagnosticEvent.mock.calls[0][0]).toMatchObject({
      level: "error",
      event: "window_error",
      fields: { errorName: "TypeError", message: "boom" },
    });
    expect(mocks.writeDiagnosticEvent.mock.calls[1][0]).toMatchObject({
      level: "error",
      event: "window_error",
      fields: { message: "Script error." },
    });
  });

  it("does not log the browser's ResizeObserver loop notice as an app error", () => {
    dispatchWindowError({
      message: RESIZE_OBSERVER_NOTICE,
      error: null,
      filename: "http://tauri.localhost/",
      lineno: 0,
      colno: 0,
    });

    expect(mocks.writeDiagnosticEvent).not.toHaveBeenCalled();
  });

  it("control: the same words thrown as a real error are still logged", () => {
    dispatchWindowError({
      message: `Uncaught Error: ${RESIZE_OBSERVER_NOTICE}`,
      error: new Error(RESIZE_OBSERVER_NOTICE),
    });
    dispatchWindowError({
      message: "ResizeObserver loop limit exceeded",
      error: null,
    });

    expect(mocks.writeDiagnosticEvent).toHaveBeenCalledTimes(2);
  });
});
