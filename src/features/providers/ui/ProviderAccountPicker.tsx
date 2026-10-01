import { useEffect, useState } from "react";
import { Check, ChevronDown, RefreshCw, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { ComposerActionButton } from "@/shared/ui/composer-action-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { isSessionRunning } from "@/features/chat/lib/sessionActivity";
import { setSessionAccount } from "@/shared/api/acpSessionRegistry";
import {
  startProviderAccountsMonitor,
  useProviderAccountsStore,
} from "../stores/providerAccountsStore";
import { ProviderAccountDetails } from "./ProviderAccountDetails";
import { ProviderAccountsPanel } from "./ProviderAccountsPanel";
import type { ProviderAccount } from "../api/providerAccounts";
import { useAccountQuotaWaitStore } from "@/features/chat/lib/accountQuotaWait";
import { resetCountdown } from "../lib/providerAccountStatus";

interface ProviderAccountPickerProps {
  providerId: string;
  sessionId?: string;
  disabled?: boolean;
  compact?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProviderAccountPicker({
  providerId,
  sessionId,
  disabled,
  compact,
  open,
  onOpenChange,
}: ProviderAccountPickerProps) {
  const { t } = useTranslation("settings");
  const { formatDate } = useLocaleFormatting();
  const accounts = useProviderAccountsStore((state) => state.accounts);
  const defaults = useProviderAccountsStore((state) => state.defaults);
  const statuses = useProviderAccountsStore((state) => state.statuses);
  const refreshing = useProviderAccountsStore((state) => state.refreshing);
  const session = useChatSessionStore((state) =>
    sessionId
      ? state.sessions.find((entry) => entry.id === sessionId)
      : undefined,
  );
  const quotaWait = useAccountQuotaWaitStore((state) =>
    sessionId ? state.waits[sessionId] : undefined,
  );
  const turnActive = useChatStore((state) => {
    const runtime = sessionId ? state.sessionStateById[sessionId] : undefined;
    return Boolean(
      runtime &&
        (isSessionRunning(runtime.chatState) ||
          runtime.activeRunId ||
          runtime.isRunCancellationPending),
    );
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(Date.now);
  const providerAccounts = accounts.filter(
    (account) => account.providerId === providerId,
  );
  const lastCheckedAt = Math.max(
    0,
    ...providerAccounts.map(
      (account) => statuses[account.id]?.lastAttemptAt ?? 0,
    ),
  );
  const selectedId = sessionId ? session?.accountId : defaults[providerId];
  const selected = providerAccounts.find(
    (account) => account.id === selectedId,
  );
  const waitingAccount = accounts.find(
    (account) => account.id === quotaWait?.accountId,
  );
  const switchingDisabled =
    disabled || turnActive || busy || Boolean(session?.creationState);

  useEffect(() => {
    startProviderAccountsMonitor();
    if (!open) return;
    void useProviderAccountsStore.getState().refresh();
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const select = async (account: ProviderAccount) => {
    if (switchingDisabled || !account.enabled) return;
    setBusy(true);
    setError(null);
    try {
      if (sessionId) {
        await setSessionAccount(sessionId, account.id);
        useChatSessionStore
          .getState()
          .patchSession(sessionId, { accountId: account.id });
      } else {
        await useProviderAccountsStore
          .getState()
          .setDefault(providerId, account.id);
      }
      onOpenChange(false);
      void useProviderAccountsStore.getState().refresh();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <ComposerActionButton
            type="button"
            size={compact ? "icon-pill-sm" : "xs"}
            leftIcon={compact ? undefined : <Users />}
            rightIcon={compact ? undefined : <ChevronDown />}
            aria-label={t("accounts.chooseAccount")}
            title={
              selected
                ? `${selected.label} · ${t(`accounts.states.${statuses[selected.id]?.state ?? "unknown"}`)}`
                : t("accounts.chooseAccount")
            }
            visualState={
              selected &&
              (statuses[selected.id]?.state === "limited" ||
                statuses[selected.id]?.state === "needs_auth")
                ? "error"
                : undefined
            }
          >
            {compact ? (
              <Users />
            ) : (
              <span className="max-w-28 truncate">
                {selected?.label ?? t("accounts.chooseAccount")}
              </span>
            )}
          </ComposerActionButton>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          className="w-96 max-w-[calc(100vw-2rem)] p-3"
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">
              {t("accounts.chooseAccount")}
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              {lastCheckedAt > 0 ? (
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={new Date(lastCheckedAt).toISOString()}
                >
                  {t("accounts.checkedAt", {
                    date: formatDate(lastCheckedAt, {
                      dateStyle: "short",
                      timeStyle: "short",
                    }),
                  })}
                </time>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                leftIcon={<RefreshCw />}
                disabled={refreshing}
                onClick={() =>
                  void useProviderAccountsStore.getState().refresh(true)
                }
              >
                {t("accounts.refresh")}
              </Button>
            </div>
          </div>
          <p className="mb-2 text-xs text-muted-foreground">
            {t(
              sessionId
                ? selected
                  ? "accounts.switchChatHint"
                  : "accounts.chooseForChat"
                : "accounts.defaultHint",
            )}
          </p>
          {disabled || turnActive ? (
            <p className="mb-2 text-xs text-muted-foreground">
              {t("accounts.waitForTurn")}
            </p>
          ) : null}
          {quotaWait ? (
            <p role="status" className="mb-2 text-xs text-muted-foreground">
              {t(
                waitingAccount
                  ? "accounts.queuedWaitAccount"
                  : "accounts.queuedWait",
                {
                  ...resetCountdown(quotaWait.retryAt, now),
                  label: waitingAccount?.label,
                },
              )}
              {quotaWait.resetTokensAvailable
                ? ` ${t("accounts.manualResetOnly")}`
                : ""}
            </p>
          ) : null}
          {error ? (
            <p
              role="alert"
              className="mb-2 break-words text-xs text-destructive"
            >
              {error}
            </p>
          ) : null}
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {providerAccounts.map((account) => (
              <div
                key={account.id}
                className="space-y-2 rounded-md border border-border p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">
                    {account.label}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    leftIcon={account.id === selectedId ? <Check /> : undefined}
                    disabled={
                      switchingDisabled ||
                      !account.enabled ||
                      account.id === selectedId ||
                      statuses[account.id]?.state === "needs_auth"
                    }
                    onClick={() => void select(account)}
                  >
                    {account.id === selectedId
                      ? t("accounts.selected")
                      : busy
                        ? t("accounts.switching")
                        : t("accounts.select")}
                  </Button>
                </div>
                <ProviderAccountDetails
                  account={account}
                  status={statuses[account.id]}
                  now={now}
                />
              </div>
            ))}
            {!providerAccounts.length ? (
              <p className="text-xs text-muted-foreground">
                {t("accounts.empty")}
              </p>
            ) : null}
          </div>
          <div className="mt-3 flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                onOpenChange(false);
                setShowAll(true);
              }}
            >
              {t("accounts.manageAll")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <Dialog open={showAll} onOpenChange={setShowAll}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t("accounts.title")}</DialogTitle>
            <DialogDescription>{t("accounts.defaultHint")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <ProviderAccountsPanel />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
