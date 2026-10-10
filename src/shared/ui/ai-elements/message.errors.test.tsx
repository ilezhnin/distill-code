import { render, screen, waitFor } from "@testing-library/react";
import { lazy, Suspense } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renderMarkdown: vi.fn(),
  reportRendererError: vi.fn(),
}));

vi.mock("@/app/lib/rendererDiagnostics", () => ({
  reportRendererError: (...args: unknown[]) =>
    mocks.reportRendererError(...args),
}));

vi.mock("streamdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("streamdown")>()),
  Streamdown: (props: { children?: string }) => mocks.renderMarkdown(props),
}));

import { ViewErrorBoundary } from "@/app/ui/ViewErrorBoundary";
import { MessageResponse } from "./message";

describe("MessageResponse rendering failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.renderMarkdown.mockImplementation(
      ({ children }: { children?: string }) => <p>{children}</p>,
    );
  });

  it("keeps the chat and composer mounted when a lazy code module fails", async () => {
    const error = new TypeError(
      "Failed to fetch dynamically imported module: http://localhost:1520/highlighted-body.js",
    );
    const BrokenHighlight = lazy(() => Promise.reject(error));
    mocks.renderMarkdown.mockImplementation(
      ({ children }: { children?: string }) =>
        children?.includes("```") ? (
          <Suspense fallback={<p>Loading code</p>}>
            <BrokenHighlight />
          </Suspense>
        ) : (
          <p>{children}</p>
        ),
    );
    const markdown = "Example:\n```ts\nconst answer = 42;\n```";
    render(
      <ViewErrorBoundary view="chat">
        <MessageResponse mode="static">{markdown}</MessageResponse>
        <MessageResponse mode="static">Another message</MessageResponse>
        <textarea aria-label="Message" defaultValue="Unsent draft" />
      </ViewErrorBoundary>,
    );

    expect(await screen.findByText(/const answer = 42/)).toHaveTextContent(
      "Example:",
    );
    expect(screen.getByText("Another message")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Unsent draft");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.reportRendererError).toHaveBeenCalledExactlyOnceWith(
      "message_response_error_boundary",
      error,
      expect.objectContaining({ componentStack: expect.any(String) }),
    );
  });

  it("keeps streamed text current without retrying the failed renderer", () => {
    mocks.renderMarkdown.mockImplementation(() => {
      throw new Error("Markdown plugin failed");
    });
    const { rerender, container } = render(
      <MessageResponse isAnimating>Partial response</MessageResponse>,
    );
    const attempts = mocks.renderMarkdown.mock.calls.length;

    rerender(
      <MessageResponse isAnimating={false}>
        Partial response now complete
      </MessageResponse>,
    );

    expect(container.textContent).toBe("Partial response now complete");
    expect(mocks.renderMarkdown).toHaveBeenCalledTimes(attempts);
    // The failed renderer's animation/layout tracking must unmount with it.
    expect(
      container.querySelector("[data-virtual-row-layout-pending]"),
    ).toBeNull();
  });

  it("renders fallback HTML as literal text and allows a fresh mount to recover", async () => {
    mocks.renderMarkdown.mockImplementation(() => {
      throw new Error("Markdown plugin failed");
    });
    const markdown = '<img src="bad" onerror="alert(1)">';
    const { container, rerender } = render(
      <MessageResponse key="first">{markdown}</MessageResponse>,
    );

    expect(container.textContent).toBe(markdown);
    expect(container.querySelector("img")).toBeNull();

    mocks.renderMarkdown.mockImplementation(() => <strong>Recovered</strong>);
    rerender(<MessageResponse key="second">New message</MessageResponse>);
    await waitFor(() => {
      expect(screen.getByText("Recovered").tagName).toBe("STRONG");
    });
  });
});
