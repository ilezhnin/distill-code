import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { reportRendererError } from "@/app/lib/rendererDiagnostics";
import { showMainWindow } from "@/app/lib/showMainWindow";
import { RendererErrorBoundary } from "./RendererErrorBoundary";

vi.mock("@/app/lib/rendererDiagnostics", () => ({
  reportRendererError: vi.fn(),
}));

vi.mock("@/app/lib/showMainWindow", () => ({
  showMainWindow: vi.fn(),
}));

function ThrowingChild(): never {
  throw new Error("render failed");
}

describe("RendererErrorBoundary", () => {
  beforeEach(() => {
    vi.mocked(reportRendererError).mockReset();
    vi.mocked(showMainWindow).mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("shows the hidden app window when the first render fails", () => {
    render(
      <RendererErrorBoundary>
        <ThrowingChild />
      </RendererErrorBoundary>,
    );

    expect(showMainWindow).toHaveBeenCalled();
  });
});
