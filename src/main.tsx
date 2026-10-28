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
