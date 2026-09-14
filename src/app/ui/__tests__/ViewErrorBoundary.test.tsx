import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  reportRendererError: vi.fn(),
}));

vi.mock("@/app/lib/rendererDiagnostics", () => ({
  reportRendererError: (...args: unknown[]) =>
    mocks.reportRendererError(...args),
}));

vi.mock("@/shared/i18n", () => ({
  i18n: { t: (key: string) => key },
}));

import { ViewErrorBoundary } from "../ViewErrorBoundary";

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("tool renderer met an unexpected payload");
  return <p>view content</p>;
}

describe("ViewErrorBoundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // React logs the caught error; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the shell around the failed view and reports the error", () => {
    render(
      <div>
        <p>sidebar</p>
        <ViewErrorBoundary view="chat" resetKey="chat">
          <Boom explode />
        </ViewErrorBoundary>
      </div>,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("common:viewError.");
    expect(screen.getByText("sidebar")).toBeInTheDocument();
    expect(mocks.reportRendererError).toHaveBeenCalledWith(
      "react_view_error_boundary",
      expect.any(Error),
      expect.objectContaining({ view: "chat" }),
    );
  });

  it("renders the view again after a retry", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ViewErrorBoundary view="chat" resetKey="chat">
        <Boom explode />
      </ViewErrorBoundary>,
    );

    rerender(
      <ViewErrorBoundary view="chat" resetKey="chat">
        <Boom explode={false} />
      </ViewErrorBoundary>,
    );
    await user.click(
      screen.getByRole("button", { name: "common:viewError.retry" }),
    );

    expect(screen.getByText("view content")).toBeInTheDocument();
  });

  it("clears the fallback when the route changes", () => {
    const { rerender } = render(
      <ViewErrorBoundary view="chat" resetKey="chat">
        <Boom explode />
      </ViewErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();

    rerender(
      <ViewErrorBoundary view="settings" resetKey="settings">
        <Boom explode={false} />
      </ViewErrorBoundary>,
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("view content")).toBeInTheDocument();
  });
});
