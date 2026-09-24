import "@/app/lib/legacyStorageMigration";
import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";

import {
  installRendererDiagnostics,
  reportRendererError,
} from "@/app/lib/rendererDiagnostics";
import { AcpToolsEvents } from "@/app/AcpToolsEvents";
import { App } from "@/app/App";
import { GitStateEvents } from "@/app/GitStateEvents";
import { RendererBootLog } from "@/app/RendererBootLog";
import { BackgroundQueuedMessageDrain } from "@/features/chat/ui/BackgroundQueuedMessageDrain";
import { ConductorGraphSync } from "@/features/conductor/ConductorGraphSync";
import { MemoryAgentSync } from "@/features/memory/MemoryAgentSync";
import { I18nProvider } from "@/shared/i18n";
import { ThemeProvider } from "@/shared/theme/ThemeProvider";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { RendererErrorBoundary } from "@/app/ui/RendererErrorBoundary";
import "@xterm/xterm/css/xterm.css";
import "@/shared/styles/globals.css";

document.title = "Distill";

// React Query's default focus detection relies on `visibilitychange`, which
// the Tauri webview does not fire when the app window merely loses or regains
// OS focus. Drive it from real window focus events so queries opted into
// refetchOnWindowFocus re-sync when the user comes back to the app.
focusManager.setEventListener((handleFocus) => {
  const onFocus = () => handleFocus(true);
  const onBlur = () => handleFocus(false);
  const onVisibilityChange = () =>
    handleFocus(document.visibilityState !== "hidden");
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibilityChange);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
const reactRoot = ReactDOM.createRoot(root);

function OptionalDistillctlBridge() {
  const [Bridge, setBridge] = React.useState<React.ComponentType | null>(null);

  React.useEffect(() => {
    let mounted = true;
    import("@/features/distillctl/bridge/DistillctlBridge")
      .then(({ DistillctlBridge }) => {
        if (mounted) {
          setBridge(() => DistillctlBridge);
        }
      })
      .catch((error) => {
        console.error("Failed to load distillctl bridge:", error);
        reportRendererError("distillctl_bridge_load_failed", error);
      });
    return () => {
      mounted = false;
    };
  }, []);

  return Bridge ? <Bridge /> : null;
}

installRendererDiagnostics({ windowKind: "main" });

reactRoot.render(
  <React.StrictMode>
    <TooltipProvider>
      <RendererErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AcpToolsEvents />
          <GitStateEvents />
          <BackgroundQueuedMessageDrain />
          <ConductorGraphSync />
          <MemoryAgentSync />
          <OptionalDistillctlBridge />
          <RendererBootLog />
          <I18nProvider>
            <ThemeProvider>
              <App />
            </ThemeProvider>
          </I18nProvider>
        </QueryClientProvider>
      </RendererErrorBoundary>
    </TooltipProvider>
  </React.StrictMode>,
);
