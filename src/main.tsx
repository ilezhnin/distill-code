import "@/app/lib/legacyStorageMigration";
import { installDevtoolsTimingBufferGuard } from "@/app/lib/devtoolsTimingBuffer";
import {
  clearStartupRetry,
  showStartupFailure,
} from "@/app/lib/startupFailure";
import { initializeRootSettings } from "@/shared/preferences/rootSettings";

installDevtoolsTimingBufferGuard();

// Native settings load before stores and UI modules derive their initial state.
export const startup = initializeRootSettings()
  .then(async () => {
    const { initializeUsageLedger } = await import(
      "@/features/stats/lib/usageLedger"
    );
    await initializeUsageLedger();
    // A restored queue or child publisher can wake as soon as React mounts.
    // Both need to know which chats already have a goal at that boundary.
    const { hydrateChatGoals } = await import(
      "@/features/chat-automation/goalStore"
    );
    await hydrateChatGoals().catch((error) =>
      console.error("Could not read chat goals:", error),
    );
    const { hydrateChatLoops } = await import(
      "@/features/chat-automation/loopStore"
    );
    await hydrateChatLoops().catch((error) =>
      console.error("Could not read chat loops:", error),
    );
    const { installCloseGuard } = await import("@/app/lib/closeGuard");
    await installCloseGuard();
    const { renderApp } = await import("@/app/renderRoot");
    renderApp();
    clearStartupRetry();
  })
  .catch((error: unknown) => {
    console.error("Cannot start Flock", error);
    showStartupFailure(error);
  });
