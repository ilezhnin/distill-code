import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccountQuotaWaitStore } from "../lib/accountQuotaWait";
import { useChatStore } from "../stores/chatStore";
import { useProviderAccountsStore } from "@/features/providers/stores/providerAccountsStore";
import { resetDuration } from "@/features/status/lib/rateLimitFormatters";
import { useLocaleFormatting } from "@/shared/i18n";

const COUNTDOWN_TICK_MS = 60_000;

/**
 * When the chat's queued messages are parked on a spent account quota: the
 * registered wait's retry time, or the runtime flag alone when only that is
 * set. Null while nothing holds the queue.
 */
export function useAccountQuotaWaitUntil(
  sessionId: string | undefined,
): number | null {
  const retryAt = useAccountQuotaWaitStore((state) =>
    sessionId ? (state.waits[sessionId]?.retryAt ?? null) : null,
  );
  const runtimeUntil = useChatStore((state) =>
    sessionId
      ? (state.sessionStateById[sessionId]?.accountQuotaWaitUntil ?? null)
      : null,
  );
  return retryAt ?? runtimeUntil;
}

/**
 * The line under the queued pills that says why they wait and until when:
 * the provider (and account) whose quota is spent, then either the next
 * check in about a minute (no reset time known yet) or the provider's reset
 * time, as a local clock time with a countdown that ticks every minute.
 */
export function QueuedAccountQuotaWait({
  sessionId,
  until,
  providerLabel,
}: {
  sessionId: string | undefined;
  until: number;
  /** The chat's provider as the composer names it, for the default subject. */
  providerLabel: string;
}) {
  const { t } = useTranslation("chat");
  const { formatDate } = useLocaleFormatting();
  const wait = useAccountQuotaWaitStore((state) =>
    sessionId ? state.waits[sessionId] : undefined,
  );
  const accountLabel = useProviderAccountsStore((state) =>
    wait?.accountId
      ? state.accounts.find((account) => account.id === wait.accountId)?.label
      : undefined,
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(
      () => setNow(Date.now()),
      COUNTDOWN_TICK_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  const subject = accountLabel
    ? t("queue.quotaWaitSubjectAccount", {
        provider: providerLabel,
        account: accountLabel,
      })
    : providerLabel;
  const sameDay =
    new Date(until).toDateString() === new Date(now).toDateString();
  const time = formatDate(
    until,
    sameDay
      ? { timeStyle: "short" }
      : { dateStyle: "short", timeStyle: "short" },
  );
  const duration = resetDuration(until, now);
  const countdown =
    duration === null || duration === "now"
      ? t("queue.quotaWaitCountdownNow")
      : t("queue.quotaWaitCountdown", { duration });
  // A wait with a reset time holds until the provider's window turns over; one
  // without is a blind re-check a minute later, before the status refresh has
  // said when the window resets.
  const text = t(
    wait?.resetAt != null ? "queue.quotaWaitReset" : "queue.quotaWaitRecheck",
    { subject, time, countdown },
  );
  return (
    <p
      role="status"
      className="px-2 pb-0.5 text-[11px] opacity-80"
      data-slot="queued-message-quota-wait"
    >
      {text}
    </p>
  );
}
