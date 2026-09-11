import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportRendererError } from "@/app/lib/rendererDiagnostics";
import { showMainWindow } from "@/app/lib/showMainWindow";
import { i18n } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";

interface RendererErrorBoundaryProps {
  children: ReactNode;
}

interface RendererErrorBoundaryState {
  hasError: boolean;
}

export class RendererErrorBoundary extends Component<
  RendererErrorBoundaryProps,
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RendererErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // A render that fails before App commits never runs the effect that shows
    // the (initially hidden) window, which left a startup crash invisible.
    showMainWindow();
    reportRendererError("react_error_boundary", error, {
      componentStack: info.componentStack ?? "",
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen min-w-0 flex-col items-center justify-center gap-3 bg-canvas-base px-6 text-center text-foreground">
          <h1 className="font-medium text-lg">
            {i18n.t("common:rendererError.title")}
          </h1>
          <p className="max-w-md text-muted-foreground text-sm">
            {i18n.t("common:rendererError.description")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => window.location.reload()}
          >
            {i18n.t("common:rendererError.reload")}
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
