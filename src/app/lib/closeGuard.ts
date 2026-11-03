import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { flushMessageQueues } from "@/features/chat/stores/queuePersistence";
import { flushUsageLedger } from "@/features/stats/lib/usageLedger";
import { flushMemoryWrites } from "@/features/memory/stores/memoryStore";
import { isDesktopRuntime } from "@/shared/api/flockStore";
import { i18n } from "@/shared/i18n";
import { cancelAppClosing, markAppClosing } from "@/shared/lib/appClosing";
import { flushFlockDocuments } from "@/shared/lib/flockDocument";
import { flushRootSettings } from "@/shared/preferences/rootSettings";

/**
 * Chats still working hold the close until the operator decides: an agent
 * stuck on a spent quota never finishes, and refusing the close outright left
 * no way to quit but killing the process. `true` closes and stops them.
 */
async function confirmStoppingActiveChats(): Promise<boolean | null> {
  const count = await invoke<number>("active_agent_host_chats");
  if (count === 0) return null;
  return ask(i18n.t("common:closeFlock.message", { count }), {
    title: i18n.t("common:closeFlock.title"),
    kind: "warning",
    okLabel: i18n.t("common:closeFlock.confirm"),
    cancelLabel: i18n.t("common:closeFlock.cancel"),
  });
}

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
    let stopChats: boolean | null;
    try {
      stopChats = await confirmStoppingActiveChats();
    } catch (error) {
      event.preventDefault();
      closing = false;
      toast.error(String(error));
      return;
    }
    if (stopChats === false) {
      event.preventDefault();
      closing = false;
      return;
    }
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
      await invoke("prepare_agent_host_shutdown", {
        prepared: true,
        stopChats: stopChats === true,
      });
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
