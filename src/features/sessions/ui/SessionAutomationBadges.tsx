import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/ui/badge";
import { useChatGoalStore } from "@/features/chat-automation/goalStore";
import { useChatLoopStore } from "@/features/chat-automation/loopStore";

export function SessionAutomationBadges({
  sessionId,
  descriptionId,
}: {
  sessionId: string;
  descriptionId: string;
}) {
  const { t } = useTranslation("chat");
  const goal = useChatGoalStore((s) => s.goals[sessionId]?.status === "active");
  const loop = useChatLoopStore((s) =>
    s.loops[sessionId]?.some((item) => item.status === "active"),
  );
  return (
    <span className="contents" id={descriptionId}>
      {goal && <Badge variant="secondary">{t("automation.activeGoal")}</Badge>}
      {loop && <Badge variant="secondary">{t("automation.activeLoop")}</Badge>}
    </span>
  );
}
