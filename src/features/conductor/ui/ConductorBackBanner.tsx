import { IconChevronLeft } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

import { TranscriptOverlayButton } from "@/shared/ui/transcript-overlay-button";

export function ConductorBackBanner({
  conductorName,
  onBack,
}: {
  conductorName: string;
  onBack: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-start px-4 sm:px-[var(--chat-transcript-inline-padding)]">
      <TranscriptOverlayButton
        type="button"
        size="sm"
        onClick={onBack}
        data-testid="conductor-back-banner"
        className="pointer-events-auto"
      >
        <IconChevronLeft className="size-4" />
        {t("conductor.backToConductor", { name: conductorName })}
      </TranscriptOverlayButton>
    </div>
  );
}
