import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/rendererLog", () => ({
  logRendererEvent: vi.fn(() => Promise.resolve()),
}));

const LAST_BOOT_KEY = "distill.renderer.lastBootAt";

describe("RendererBootLog", () => {
  beforeEach(() => {
    // Reset module state so the one-shot boot guard fires again each test.
    vi.resetModules();
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("reports a first boot when there is no prior load timestamp", async () => {
    const api = await import("@/shared/api/rendererLog");
    const { RendererBootLog } = await import("./RendererBootLog");

    render(<RendererBootLog />);

    await waitFor(() => {
      expect(api.logRendererEvent).toHaveBeenCalled();
    });
    expect(api.logRendererEvent).toHaveBeenCalledWith(
      "info",
      expect.stringContaining("first load"),
    );
    expect(localStorage.getItem(LAST_BOOT_KEY)).not.toBeNull();
  });

  it("notes a reload that happens shortly after the previous load", async () => {
    localStorage.setItem(LAST_BOOT_KEY, String(Date.now() - 2_000));

    const api = await import("@/shared/api/rendererLog");
    const { RendererBootLog } = await import("./RendererBootLog");

    render(<RendererBootLog />);

    await waitFor(() => {
      expect(api.logRendererEvent).toHaveBeenCalled();
    });
    expect(api.logRendererEvent).toHaveBeenCalledWith(
      expect.stringMatching(/^(info|warn)$/),
      expect.stringContaining("reloaded"),
    );
  });
});
