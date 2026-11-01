import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { flushMessageQueues } from "@/features/chat/stores/queuePersistence";
import { flushUsageLedger } from "@/features/stats/lib/usageLedger";
import { flushMemoryWrites } from "@/features/memory/stores/memoryStore";
import { isDesktopRuntime } from "@/shared/api/flockStore";
import { cancelAppClosing, markAppClosing } from "@/shared/lib/appClosing";
import { flushFlockDocuments } from "@/shared/lib/flockDocument";
import { flushRootSettings } from "@/shared/preferences/rootSettings";

/** Leave the window available for recovery when a save fails. */
export async function installCloseGuard(): Promise<void> {
  if (!isDesktopRuntime()) return;
  let closing = false;
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (closing) {
      event.preventDefault();
      return;
    }
    closing = true;
    // Said before anything else happens: the host shutdown below stops every
    // worker, and the wave engine has to read that as the window closing, not
    // as workers finishing — it used to start the next step on the way down.
    markAppClosing();
    const root = document.getElementById("root");
    if (root) root.inert = true;
    try {
      flushUsageLedger();
      await Promise.all([
        flushFlockDocuments(),
        flushMessageQueues(),
        flushRootSettings(),
        flushMemoryWrites(),
      ]);
      await invoke("prepare_agent_host_shutdown", { prepared: true });
      // The Tauri listener destroys the window only after this handler resolves.
    } catch (error) {
      event.preventDefault();
      closing = false;
      cancelAppClosing();
      if (root) root.inert = false;
      toast.error(String(error));
    }
  });
}
