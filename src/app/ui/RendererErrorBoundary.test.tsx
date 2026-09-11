import { render, screen, waitFor } from "@testing-library/react";
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

  it("reports React render failures and shows reload fallback", async () => {
    render(
      <RendererErrorBoundary>
        <ThrowingChild />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole("heading")).toHaveTextContent(
      "Something went wrong",
    );
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    await waitFor(() => {
      expect(reportRendererError).toHaveBeenCalledWith(
        "react_error_boundary",
        expect.any(Error),
        expect.objectContaining({
          componentStack: expect.any(String),
        }),
      );
    });
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
