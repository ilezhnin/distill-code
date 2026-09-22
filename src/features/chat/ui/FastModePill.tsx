import { useTranslation } from "react-i18next";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { toSentenceCaseLabel } from "../lib/effectiveReasoningEffort";
import type { ChatInputFastMode } from "../types";

/** Immediate composer control, including before a draft has a live session. */
export function FastModePill({
  fastMode,
  supportsFast,
  disabled = false,
  triggerTabIndex,
}: {
  fastMode?: ChatInputFastMode;
  supportsFast?: boolean;
  disabled?: boolean;
  triggerTabIndex?: number;
}) {
  const { t } = useTranslation("chat");
  if (!fastMode?.onChange || (!fastMode.config && !supportsFast)) return null;
  const enabled = fastMode.config?.enabled ?? fastMode.desired ?? false;
  const label =
    toSentenceCaseLabel(fastMode.config?.name) || t("toolbar.fastMode");
  return (
    <ComposerActionButton
      type="button"
      size="sm"
      disabled={disabled}
      tabIndex={triggerTabIndex}
      aria-pressed={enabled}
      visualState={enabled ? "on" : undefined}
      onClick={() => fastMode.onChange?.(!enabled)}
      tooltip={
        enabled
          ? t("toolbar.fastModeDisable", { name: label })
          : t("toolbar.fastModeEnable", { name: label })
      }
      className="shrink-0"
    >
      {label}
    </ComposerActionButton>
  );
}
