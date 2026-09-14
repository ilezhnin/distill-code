import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportRendererError } from "@/app/lib/rendererDiagnostics";
import { i18n } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";

interface ViewErrorBoundaryProps {
  children: ReactNode;
  /** The view this boundary guards; goes into the diagnostic event. */
  view: string;
  /**
   * Changing this clears a caught error, so navigating away from a broken view
   * and back does not leave the fallback stuck on screen.
   */
  resetKey?: string;
}

interface ViewErrorBoundaryState {
  hasError: boolean;
  resetKey?: string;
}

/**
 * A throw inside one view stops at that view.
 *
 * The renderer had a single root boundary, so any render error — a message or
 * tool renderer meeting an unexpected payload, a markdown plugin, a missing
 * provider — replaced the whole window with "Something went wrong", and the
 * reload it offered dropped composer drafts, scroll positions and every other
 * in-memory-only piece of state. Keeping the shell alive means the sidebar,
 * the other chats and the drafts survive, and the operator can navigate away
 * or retry the view.
 */
export class ViewErrorBoundary extends Component<
  ViewErrorBoundaryProps,
  ViewErrorBoundaryState
> {
  state: ViewErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): Partial<ViewErrorBoundaryState> {
    return { hasError: true };
  }

  static getDerivedStateFromProps(
    props: ViewErrorBoundaryProps,
    state: ViewErrorBoundaryState,
  ): Partial<ViewErrorBoundaryState> | null {
    if (state.resetKey === props.resetKey) return null;
    return { hasError: false, resetKey: props.resetKey };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportRendererError("react_view_error_boundary", error, {
      componentStack: info.componentStack ?? "",
      view: this.props.view,
    });
  }

  private retry = () => {
    this.setState({ hasError: false });
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div
        role="alert"
        className="flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center gap-3 px-6 text-center text-foreground"
      >
        <p className="font-medium text-sm">
          {i18n.t("common:viewError.title")}
        </p>
        <p className="max-w-md text-muted-foreground text-xs">
          {i18n.t("common:viewError.description")}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={this.retry}>
          {i18n.t("common:viewError.retry")}
        </Button>
      </div>
    );
  }
}
