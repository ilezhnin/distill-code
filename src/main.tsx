import "@/app/lib/legacyStorageMigration";
import { initializeRootSettings } from "@/shared/preferences/rootSettings";

// Native settings load before stores and UI modules derive their initial state.
export const startup = initializeRootSettings()
  .then(async () => {
    const { initializeUsageLedger } = await import(
      "@/features/stats/lib/usageLedger"
    );
    await initializeUsageLedger();
    const { renderApp } = await import("@/app/renderRoot");
    renderApp();
  })
  .catch((error: unknown) => {
    console.error("Cannot load Distill configuration", error);
    const message = document.createElement("p");
    message.textContent = String(error);
    document.getElementById("root")?.replaceChildren(message);
  });
