import { toast } from "sonner";
import { i18n } from "@/shared/i18n";
import { ToastActionButton, ToastActionGroup } from "@/shared/ui/sonner";

export type CompletionNotificationOutcome = "completed" | "error" | "stopped";

const TOAST_DURATION_MS = 8000;

export function getCompletionToastDescription(
  outcome: CompletionNotificationOutcome,
): string {
  return i18n.t(`common:completionNotification.description.${outcome}`);
}

export function showCompletionNotificationToast({
  title,
  outcome,
  onView,
  onChangeSound,
}: {
  title: string;
  outcome: CompletionNotificationOutcome;
  onView: () => void;
  onChangeSound?: () => void;
}): void {
  let toastId: string | number | undefined;
  const handleView = () => {
    if (toastId !== undefined) {
      toast.dismiss(toastId);
    }
    onView();
  };
  const handleChangeSound = () => {
    if (toastId !== undefined) {
      toast.dismiss(toastId);
    }
    onChangeSound?.();
  };

  const viewLabel = i18n.t("common:completionNotification.view");
  const action = onChangeSound ? (
    <ToastActionGroup>
      <ToastActionButton
        className="ml-0"
        emphasis="secondary"
        onClick={handleChangeSound}
      >
        {i18n.t("common:completionNotification.changeSound")}
      </ToastActionButton>
      <ToastActionButton className="ml-0" onClick={handleView}>
        {viewLabel}
      </ToastActionButton>
    </ToastActionGroup>
  ) : (
    <ToastActionButton onClick={handleView}>{viewLabel}</ToastActionButton>
  );

  const options = {
    action,
    description: getCompletionToastDescription(outcome),
    duration: TOAST_DURATION_MS,
  };

  if (outcome === "error") {
    toastId = toast.error(title, options);
    return;
  }

  toastId = toast(title, options);
}
