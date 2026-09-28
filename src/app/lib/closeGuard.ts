import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { toast } from "sonner";
import { flushMessageQueues } from "@/features/chat/stores/queuePersistence";
import { flushUsageLedger } from "@/features/stats/lib/usageLedger";
import { flushMemoryWrites } from "@/features/memory/stores/memoryStore";
import { isDesktopRuntime } from "@/shared/api/distillStore";
import { flushDistillDocuments } from "@/shared/lib/distillDocument";
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
    const root = document.getElementById("root");
    if (root) root.inert = true;
    try {
      flushUsageLedger();
      await Promise.all([
        flushDistillDocuments(),
        flushMessageQueues(),
        flushRootSettings(),
        flushMemoryWrites(),
      ]);
      await invoke("prepare_agent_host_shutdown", { prepared: true });
      // The Tauri listener destroys the window only after this handler resolves.
    } catch (error) {
      event.preventDefault();
      closing = false;
      if (root) root.inert = false;
      toast.error(String(error));
    }
  });
}
