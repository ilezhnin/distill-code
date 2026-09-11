import { useEffect } from "react";

import { AppShell } from "@/app/AppShell";
import { TopBarActionsProvider } from "@/app/contexts/TopBarActionsContext";
import { showMainWindow } from "@/app/lib/showMainWindow";
import { SelectedTextContextMenu } from "@/app/ui/SelectedTextContextMenu";
import { useZoom } from "@/shared/hooks/useZoom";
import { Toaster } from "@/shared/ui/sonner";

export function App() {
  useZoom();

  useEffect(() => {
    const preventWindowFileNavigation = (event: DragEvent) => {
      event.preventDefault();
    };

    window.addEventListener("dragover", preventWindowFileNavigation);
    window.addEventListener("drop", preventWindowFileNavigation);

    showMainWindow();

    return () => {
      window.removeEventListener("dragover", preventWindowFileNavigation);
      window.removeEventListener("drop", preventWindowFileNavigation);
    };
  }, []);

  return (
    <>
      <TopBarActionsProvider>
        <AppShell />
      </TopBarActionsProvider>
      <SelectedTextContextMenu />
      <Toaster />
    </>
  );
}
