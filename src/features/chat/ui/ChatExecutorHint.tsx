import { useTranslation } from "react-i18next";
import { formatProviderLabel } from "@/shared/ui/icons/ProviderIcons";
import { workClassLabel } from "@/features/benchmarks/lib/benchmarkLabels";
import {
  useChatExecutorHint,
  type ExecutorHintReader,
} from "../hooks/useChatExecutorHint";

/** A local preview of the common selector; choosing a model stays explicit. */
export function ChatExecutorHint({
  open,
  read,
}: {
  open: boolean;
  read?: ExecutorHintReader;
}) {
  const { t } = useTranslation(["chat", "settings"]);
  const hint = useChatExecutorHint(open, read);
  if (!hint || (!hint.failed && !hint.decision)) return null;
  const chosen = hint.decision?.chosen;
  const status = hint.decision?.learnedStatus ?? "";
  // Why the class's learned selector did or did not choose this task.
  const learnedNote =
    status === "no_class_certificate"
      ? t("executorHint.noCertificate")
      : status.startsWith("class_policy_abstained:")
        ? t("executorHint.abstained", {
            reason: status.slice("class_policy_abstained:".length),
          })
        : null;
  const description = hint.failed
    ? t("executorHint.failed")
    : !chosen
      ? t(
          hint.decision?.reason === "pinned_candidate_unavailable"
            ? "executorHint.pinUnavailable"
            : "executorHint.unavailable",
        )
      : t(
          hint.decision?.source === "pin"
            ? "executorHint.pinned"
            : hint.decision?.source === "learned"
              ? "executorHint.learned"
              : "executorHint.prior",
          {
            model: [
              chosen.modelName ?? chosen.modelId,
              formatProviderLabel(chosen.providerId),
              chosen.effort,
              chosen.fastMode === null
                ? null
                : t(
                    chosen.fastMode
                      ? "executorHint.fast"
                      : "executorHint.standard",
                  ),
            ]
              .filter(Boolean)
              .join(" · "),
          },
        );
  return (
    <div
      role="status"
      className="shrink-0 space-y-1 border-t px-3 py-2 text-xs text-muted-foreground"
    >
      <p>{description}</p>
      {hint.decision ? (
        <p>
          {t("executorHint.basis", {
            workClass: workClassLabel(
              t,
              hint.decision.request.prediction.task.workClassId,
            ),
          })}
        </p>
      ) : null}
      {learnedNote ? <p>{learnedNote}</p> : null}
    </div>
  );
}
