import { useTranslation } from "react-i18next";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import type { ChatSessionFastModeConfig } from "../stores/chatSessionStore";
import { toSentenceCaseLabel } from "../lib/effectiveReasoningEffort";

interface FastModePillProps {
  config?: ChatSessionFastModeConfig;
  onToggle?: (enabled: boolean) => void;
  disabled?: boolean;
  triggerTabIndex?: number;
}

/**
 * Composer toggle for the session-advertised fast-mode option (Claude Code
 * `fast`). Hidden entirely when the session does not advertise the option.
 */
export function FastModePill({
  config,
  onToggle,
  disabled = false,
  triggerTabIndex,
}: FastModePillProps) {
  const { t } = useTranslation("chat");

  if (!config) {
    return null;
  }

  const label = toSentenceCaseLabel(config.name) || t("toolbar.fastMode");

  return (
    <ComposerActionButton
      type="button"
      size="sm"
      disabled={disabled}
      tabIndex={triggerTabIndex}
      aria-pressed={config.enabled}
      visualState={config.enabled ? "on" : undefined}
      onClick={() => onToggle?.(!config.enabled)}
      tooltip={
        config.enabled
          ? t("toolbar.fastModeDisable", { name: label })
          : t("toolbar.fastModeEnable", { name: label })
      }
      className="shrink-0"
    >
      {label}
    </ComposerActionButton>
  );
}
