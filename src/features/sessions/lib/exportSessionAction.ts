import { toast } from "sonner";

import { acpExportSession } from "@/shared/api/acp";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { saveExportedSessionFile } from "@/shared/api/system";
import { i18n } from "@/shared/i18n";
import {
  defaultExportFilename,
  downloadJson,
  exportFilenameFromPath,
} from "./exportSession";

export interface ExportSessionActionOptions {
  sessionId: string;
  title: string;
  displayTitle: string;
  onNotFound?: () => void;
}

function isSessionNotFoundError(error: unknown): boolean {
  const message = formatAcpErrorMessage(error, "");
  return /session .*not found/i.test(message);
}

export async function exportSessionAction({
  sessionId,
  title,
  displayTitle,
  onNotFound,
}: ExportSessionActionOptions): Promise<void> {
  try {
    const json = await acpExportSession(sessionId);
    const filename = defaultExportFilename(title || "session");

    if (window.__TAURI_INTERNALS__) {
      const savedPath = await saveExportedSessionFile(filename, json);
      if (!savedPath) return;
      const savedFilename = exportFilenameFromPath(savedPath, filename);
      toast.success(
        i18n.t("common:session.exported", {
          title: displayTitle,
          filename: savedFilename,
        }),
      );
      return;
    }

    downloadJson(json, filename);
    toast.success(
      i18n.t("common:session.exported", { title: displayTitle, filename }),
    );
  } catch (error) {
    console.error("Export failed:", error);
    if (isSessionNotFoundError(error)) {
      onNotFound?.();
    }
    toast.error(
      formatAcpErrorMessage(error, i18n.t("common:session.exportFailed")),
    );
  }
}
