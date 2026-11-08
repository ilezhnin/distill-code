import { Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { useComputerUse } from "../hooks/useComputerUse";

/**
 * The composer switch that lets a chat's agent operate apps on this PC in the
 * background. Off by default; shown once the chat has a session the host
 * knows. The change applies from the chat's next turn, so it waits while a
 * turn runs.
 */
export function ComputerUsePill({
  sessionId,
  runActive = false,
  disabled = false,
}: {
  sessionId?: string;
  runActive?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("chat");
  const { known, enabled, pending, toggle } = useComputerUse(sessionId);
  if (!known) return null;
  const tooltip = pending
    ? enabled
      ? t("toolbar.computerUseTurningOff")
      : t("toolbar.computerUseSettingUp")
    : runActive
      ? t("toolbar.computerUseNeedsIdle")
      : enabled
        ? t("toolbar.computerUseDisable")
        : t("toolbar.computerUseEnable");
  return (
    <ComposerActionButton
      type="button"
      size="sm"
      disabled={disabled}
      aria-disabled={runActive || undefined}
      aria-pressed={enabled}
      feedbackState={pending ? "loading" : "idle"}
      loadingVisual="spinnerText"
      loadingLabel={t("toolbar.computerUse")}
      visualState={enabled ? "on" : undefined}
      leftIcon={pending ? undefined : <Monitor aria-hidden="true" />}
      onClick={() => void toggle()}
      tooltip={tooltip}
      className="shrink-0"
    >
      {t("toolbar.computerUse")}
    </ComposerActionButton>
  );
}
