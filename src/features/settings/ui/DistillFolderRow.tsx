/**
 * Where everything Distill owns lives — the row that makes it the operator's
 * choice rather than the operating system's.
 *
 * Two things this row must be honest about, and both are the reason it exists
 * as its own component rather than a line in a list:
 *
 * - **Changing it does not move anything.** Copying gigabytes while goose
 *   holds files open is how people lose a folder. The operator moves it, the
 *   app picks it up. Saying so is not a caveat, it is the instruction.
 * - **It takes effect on restart.** goose is told where to live once, when it
 *   starts. Half the app pointing at a new folder while the other half still
 *   holds the old one is the exact split a single root exists to prevent.
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconFolder } from "@tabler/icons-react";

import {
  getDistillRoot,
  setDistillRoot,
  type DistillRootInfo,
} from "@/shared/api/distillStore";
import { Button } from "@/shared/ui/button";
import { SettingsRow } from "@/shared/ui/settings-row";
import { toast } from "sonner";

export function DistillFolderRow() {
  const { t } = useTranslation("settings");
  const [info, setInfo] = useState<DistillRootInfo | null>(null);
  const [pendingRoot, setPendingRoot] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDistillRoot().then((next) => {
      if (!cancelled) setInfo(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const choose = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        defaultPath: info?.root ?? undefined,
        directory: true,
        multiple: false,
        title: t("general.distillFolder.chooseDialogTitle"),
      });
      if (typeof selected !== "string") return;

      await setDistillRoot(selected);
      setPendingRoot(selected);
      toast.success(t("general.distillFolder.saved"), {
        description: t("general.distillFolder.savedDescription"),
      });
    } catch (error) {
      console.warn("Failed to choose the Distill folder:", error);
      toast.error(t("general.distillFolder.saveError"));
    }
  }, [info?.root, t]);

  if (!info) return null;

  return (
    <SettingsRow
      label={t("general.distillFolder.label")}
      description={t("general.distillFolder.description")}
      align="start"
    >
      <div className="flex max-w-80 flex-col items-end gap-2">
        <p
          className="max-w-80 truncate text-right text-xs text-muted-foreground"
          title={pendingRoot ?? info.root}
          data-testid="distill-folder-path"
        >
          {pendingRoot ?? info.root}
        </p>
        {pendingRoot ? (
          <p
            className="max-w-80 text-right text-xs text-warning"
            data-testid="distill-folder-restart"
          >
            {t("general.distillFolder.restartRequired")}
          </p>
        ) : null}
        {!info.holdsEverything && info.legacyDataDir ? (
          // The operator would otherwise read "everything lives here" while
          // their chats sat somewhere else entirely.
          <p
            className="max-w-80 text-right text-xs text-warning"
            data-testid="distill-folder-legacy"
            title={info.legacyDataDir}
          >
            {t("general.distillFolder.legacyDataElsewhere", {
              path: info.legacyDataDir,
            })}
          </p>
        ) : null}
        {info.forcedByEnvironment ? (
          // The setting is not in charge right now; saying otherwise would
          // have the operator changing a value that does nothing.
          <p
            className="max-w-80 text-right text-xs text-muted-foreground"
            data-testid="distill-folder-forced"
          >
            {t("general.distillFolder.forcedByEnvironment")}
          </p>
        ) : (
          <Button type="button" variant="subtle" size="xs" onClick={choose}>
            <IconFolder className="size-3.5" />
            {t("general.distillFolder.choose")}
          </Button>
        )}
      </div>
    </SettingsRow>
  );
}
