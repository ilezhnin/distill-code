import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, Plus, RefreshCw } from "lucide-react";
import { useLocaleFormatting } from "@/shared/i18n";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { Badge } from "@/shared/ui/badge";
import { Switch } from "@/shared/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  startProviderAccountsMonitor,
  useProviderAccountsStore,
} from "../stores/providerAccountsStore";
import {
  consumeProviderAccountReset,
  type AccountResetOutcome,
  type ProviderAccount,
  type ProviderAccountAuthMethod,
  type ProviderAccountModel,
  type ProviderAccountState,
  type ProviderConnectionFlow,
} from "../api/providerAccounts";
import type { AgentProviderReadiness } from "../hooks/useAgentProviderStatus";
import {
  canUseAccountReset,
  earliestAccountReset,
  resetCountdown,
} from "../lib/providerAccountStatus";
import { ProviderAccountDetails } from "./ProviderAccountDetails";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { providerDisplayName as providerLabel } from "../providerCatalog";

/**
 * The model of a provider the host has not listed: the shape every card
 * renders from, with nothing in it yet.
 */
function emptyModel(providerId: string): ProviderAccountModel {
  return {
    providerId,
    connection: "browser_or_api_key",
    accountLimit: null,
    reportsUsage: false,
    supportsSignOut: true,
    accounts: [],
    defaultAccountId: null,
    automaticSwitching: false,
  };
}

/**
 * Settings > AI providers: one card per provider, every card of the same
 * structure, rendered from the account model the host lists.
 */
export function ProviderAccountsPanel({
  renderProviderHeader,
  onRefresh,
  providerIds,
  readiness,
}: {
  renderProviderHeader?: (providerId: string) => ReactNode;
  onRefresh?: () => void;
  /** The providers to show, in order; every listed provider by default. */
  providerIds?: readonly string[];
  /** The harness probe's word, for a sign-in no status adapter reports on. */
  readiness?: ReadonlyMap<string, AgentProviderReadiness>;
}) {
  const { t } = useTranslation("settings");
  const { formatDate } = useLocaleFormatting();
  const listed = useProviderAccountsStore((state) => state.providers);
  const statuses = useProviderAccountsStore((state) => state.statuses);
  const loaded = useProviderAccountsStore((state) => state.loaded);
  const refreshing = useProviderAccountsStore((state) => state.refreshing);
  const error = useProviderAccountsStore((state) => state.error);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const lastCheckedAt = Math.max(
    0,
    ...Object.values(statuses).map((status) => status.lastAttemptAt ?? 0),
  );
  useEffect(() => {
    startProviderAccountsMonitor();
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const providers = [
    ...new Set([
      ...(providerIds ?? []),
      ...listed.map((model) => model.providerId),
    ]),
  ];

  return (
    <section aria-label={t("accounts.title")} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-medium">{t("accounts.title")}</h3>
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
            variant="outline"
            size="xs"
            leftIcon={<RefreshCw />}
            disabled={refreshing}
            onClick={() => {
              void useProviderAccountsStore.getState().refresh(true);
              onRefresh?.();
            }}
          >
            {refreshing ? t("accounts.refreshing") : t("accounts.refresh")}
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!loaded ? (
        <p className="text-xs text-muted-foreground">{t("accounts.loading")}</p>
      ) : (
        providers.map((providerId) => (
          <ProviderCard
            key={providerId}
            providerId={providerId}
            now={now}
            onAdd={() => setAddingFor(providerId)}
            header={renderProviderHeader?.(providerId)}
            harnessReadiness={readiness?.get(providerId)}
          />
        ))
      )}
      {addingFor ? (
        <AccountConnectionDialog
          providerId={addingFor}
          connection={
            useProviderAccountsStore.getState().providersById[addingFor]
              ?.connection ?? "browser_or_api_key"
          }
          onClose={() => setAddingFor(null)}
        />
      ) : null}
    </section>
  );
}

function ProviderCard({
  providerId,
  now,
  onAdd,
  header,
  harnessReadiness,
}: {
  providerId: string;
  now: number;
  onAdd: () => void;
  header?: ReactNode;
  harnessReadiness?: AgentProviderReadiness;
}) {
  const { t } = useTranslation("settings");
  const { formatDate } = useLocaleFormatting();
  const model =
    useProviderAccountsStore((state) => state.providersById[providerId]) ??
    emptyModel(providerId);
  const statuses = useProviderAccountsStore((state) => state.statuses);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = providerLabel(providerId);
  // A provider that holds one sign-in has nothing to switch between and no
  // room for another account until that sign-in is signed out.
  const single = model.accountLimit === 1;
  const full =
    model.accountLimit != null && model.accounts.length >= model.accountLimit;
  const resetAt = model.automaticSwitching
    ? earliestAccountReset(model.accounts, statuses, now)
    : null;
  const setRouting = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await useProviderAccountsStore.getState().setRouting(providerId, enabled);
    } catch (failure) {
      setError(String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section
      aria-label={name}
      className="space-y-3 rounded-md border border-border p-4"
    >
      {header ?? (
        <div className="flex items-center gap-3">
          {getProviderIcon(providerId, "size-6")}
          <h4 className="text-sm font-medium">{name}</h4>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <Switch
                id={`automatic-${providerId}`}
                aria-label={t("accounts.autoSwitchLabel", { provider: name })}
                checked={model.automaticSwitching}
                disabled={saving || single}
                onCheckedChange={(checked) => void setRouting(checked)}
              />
              <Label
                htmlFor={`automatic-${providerId}`}
                className="text-xs text-muted-foreground"
              >
                {t("accounts.autoSwitch")}
              </Label>
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {single
              ? t("accounts.singleSignIn", { provider: name })
              : t("accounts.autoSwitchDescription")}
          </TooltipContent>
        </Tooltip>
        <Button
          type="button"
          variant="outline"
          size="xs"
          leftIcon={<Plus />}
          disabled={full}
          onClick={onAdd}
        >
          {t("accounts.add")}
        </Button>
      </div>
      {single ? (
        <p className="text-xs text-muted-foreground">
          {t("accounts.singleSignIn", { provider: name })}
        </p>
      ) : null}
      {resetAt ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("accounts.allLimited", {
            date: formatDate(resetAt, {
              dateStyle: "short",
              timeStyle: "short",
            }),
            ...resetCountdown(resetAt, now),
          })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="divide-y divide-border border-t border-border">
        {!model.accounts.length ? (
          <p className="py-4 text-xs text-muted-foreground">
            {t("accounts.empty")}
          </p>
        ) : null}
        {model.accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            model={model}
            now={now}
            harnessReadiness={harnessReadiness}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * The state an account row paints. A status adapter's word stands; a CLI
 * sign-in no adapter reports on (Copilot, Amp) takes the harness probe's.
 */
function rowState(
  model: ProviderAccountModel,
  state: ProviderAccountState | undefined,
  harnessReadiness: AgentProviderReadiness | undefined,
): ProviderAccountState | undefined {
  if (state !== undefined && state !== "unknown") return state;
  if (model.connection !== "cli") return state;
  if (harnessReadiness === "ready") return "ready";
  if (harnessReadiness === "not_ready") return "needs_auth";
  return state;
}

function AccountRow({
  account,
  model,
  now,
  harnessReadiness,
}: {
  account: ProviderAccount;
  model: ProviderAccountModel;
  now: number;
  harnessReadiness?: AgentProviderReadiness;
}) {
  const { t } = useTranslation("settings");
  const { formatDate } = useLocaleFormatting();
  const status = useProviderAccountsStore(
    (state) => state.statuses[account.id],
  );
  const auth = useProviderAccountsStore(
    (state) => state.authStates[account.id],
  );
  const isDefault = model.defaultAccountId === account.id;
  const sessionCount = useChatSessionStore(
    (state) =>
      state.sessions.filter(
        (session) => !session.archivedAt && session.accountId === account.id,
      ).length,
  );
  const [connecting, setConnecting] = useState(false);
  const [resetRequest, setResetRequest] = useState<{
    key: string;
    creditId?: string;
    expiresAt?: number | null;
  } | null>(null);
  const [resetOutcome, setResetOutcome] = useState<AccountResetOutcome | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  const cli = model.connection === "cli";
  const state = rowState(model, status?.state, harnessReadiness);
  const authenticating = auth?.status === "running";
  const hasAuthenticatedStatus = state === "ready" || state === "limited";
  const needsSignIn =
    state === "needs_auth" ||
    (!hasAuthenticatedStatus &&
      (auth?.status === "needs_auth" || auth?.status === "error"));
  const canReset =
    !authenticating &&
    !needsSignIn &&
    account.enabled &&
    canUseAccountReset(status, now);
  const showDefaultReset = canReset && !status?.resetTokens?.credits?.length;
  const displayName = status?.accountLabel || account.label;
  const signIn = () => {
    if (account.authMethod === "api_key" && !cli) setConnecting(true);
    else void useProviderAccountsStore.getState().authenticate(account.id);
  };
  return (
    <article className="space-y-3 py-4" aria-label={displayName}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h5 className="break-all text-sm font-medium">{displayName}</h5>
            {isDefault ? (
              <Badge variant="outline">
                <Check />
                {t("accounts.default")}
              </Badge>
            ) : null}
            <Badge variant="secondary">
              {t(`accounts.methods.${account.authMethod}`)}
            </Badge>
          </div>
          {displayName !== account.label ? (
            <p className="break-all text-xs text-muted-foreground">
              {account.label}
            </p>
          ) : null}
          {sessionCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("accounts.sessionCount", { count: sessionCount })}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isDefault && !needsSignIn && !authenticating ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={busy || !account.enabled || authenticating}
              onClick={() =>
                void run(() =>
                  useProviderAccountsStore
                    .getState()
                    .setDefault(account.providerId, account.id),
                )
              }
            >
              {t("accounts.setDefault")}
            </Button>
          ) : null}
          {authenticating ? (
            // A CLI's own sign-in runs to its end; only a browser sign-in
            // Flock started can be cancelled here.
            cli ? null : (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    useProviderAccountsStore
                      .getState()
                      .cancelAuthentication(account.id),
                  )
                }
              >
                {t("accounts.cancelSignIn")}
              </Button>
            )
          ) : needsSignIn || state === undefined ? (
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={authenticating || busy}
              onClick={signIn}
            >
              {t("accounts.signIn")}
            </Button>
          ) : model.supportsSignOut ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy || authenticating}
              onClick={() =>
                void run(() =>
                  useProviderAccountsStore.getState().signOut(account.id),
                )
              }
            >
              {t("accounts.signOut")}
            </Button>
          ) : null}
        </div>
      </div>
      {!needsSignIn && !authenticating ? (
        <ProviderAccountDetails
          account={account}
          status={status}
          state={state}
          now={now}
          resetDisabled={busy || authenticating || !account.enabled}
          onUseReset={(credit) => {
            setError(null);
            setResetOutcome(null);
            setResetRequest({
              key: crypto.randomUUID(),
              creditId: credit.id,
              expiresAt: credit.expiresAt,
            });
          }}
        />
      ) : null}
      {showDefaultReset ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy}
            onClick={() => {
              setError(null);
              setResetOutcome(null);
              setResetRequest({ key: crypto.randomUUID() });
            }}
          >
            {t("accounts.useReset")}
          </Button>
        </div>
      ) : null}
      {authenticating ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("accounts.browserPending")}
        </p>
      ) : null}
      {auth?.message &&
      (auth.status === "error" || auth.status === "needs_auth") ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {auth.message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="break-words text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {resetOutcome ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t(`accounts.resetOutcomes.${resetOutcome}`)}
        </p>
      ) : null}
      {connecting ? (
        <AccountConnectionDialog
          providerId={account.providerId}
          connection={model.connection}
          account={account}
          onClose={() => setConnecting(false)}
        />
      ) : null}
      <ConfirmDialog
        open={resetRequest !== null}
        onOpenChange={(open) => {
          if (!open) setResetRequest(null);
        }}
        title={t("accounts.resetTitle")}
        description={
          <span className="block space-y-2">
            <span className="block font-medium">
              {providerLabel(account.providerId)} · {displayName}
            </span>
            <span className="block">{t("accounts.resetDescription")}</span>
            {resetRequest?.expiresAt ? (
              <span className="block">
                {t("accounts.expiresAt", {
                  date: formatDate(resetRequest.expiresAt, {
                    dateStyle: "long",
                    timeStyle: "short",
                  }),
                })}
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="block text-destructive">
                {error}
              </span>
            ) : null}
          </span>
        }
        cancelLabel={t("accounts.cancel")}
        confirmLabel={t("accounts.confirmReset")}
        destructive={false}
        showCloseButton={false}
        isLoading={busy}
        onConfirm={() =>
          run(async () => {
            if (!resetRequest) return;
            const result = await consumeProviderAccountReset(
              account.id,
              resetRequest.key,
              resetRequest.creditId,
            );
            setResetOutcome(result.outcome);
            setResetRequest(null);
            await useProviderAccountsStore.getState().refresh(true);
          })
        }
      />
    </article>
  );
}

/** The connection types a flow offers, the first being the default. */
function connectionMethods(
  connection: ProviderConnectionFlow,
): ProviderAccountAuthMethod[] {
  return connection === "api_key" ? ["api_key"] : ["oauth", "api_key"];
}

function AccountConnectionDialog({
  providerId,
  connection,
  account,
  onClose,
}: {
  providerId: string;
  connection: ProviderConnectionFlow;
  account?: ProviderAccount;
  onClose: () => void;
}) {
  const { t } = useTranslation("settings");
  const methods = connectionMethods(connection);
  const [label, setLabel] = useState(account?.label ?? "");
  const [method, setMethod] = useState<ProviderAccountAuthMethod>(
    account?.authMethod ?? methods[0],
  );
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    if (!label.trim() || (method === "api_key" && !apiKey.trim())) return;
    setBusy(true);
    setError(null);
    try {
      if (account) {
        await useProviderAccountsStore.getState().update(account.id, {
          apiKey: apiKey.trim(),
        });
      } else {
        const created = await useProviderAccountsStore.getState().add({
          providerId,
          label: label.trim(),
          authMethod: method,
          ...(method === "api_key" ? { apiKey: apiKey.trim() } : {}),
        });
        if (method === "oauth")
          void useProviderAccountsStore.getState().authenticate(created.id);
      }
      setApiKey("");
      onClose();
    } catch (failure) {
      setError(String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          setApiKey("");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(account ? "accounts.connectTitle" : "accounts.addTitle", {
              provider: providerLabel(providerId),
            })}
          </DialogTitle>
          <DialogDescription>
            {t([
              `accounts.connect.${providerId}.description`,
              "accounts.addDescription",
            ])}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {!account ? (
            <div className="space-y-2">
              <Label htmlFor="provider-account-label">
                {t("accounts.label")}
              </Label>
              <Input
                id="provider-account-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                autoFocus
                maxLength={120}
              />
            </div>
          ) : null}
          {!account ? (
            <div className="space-y-2">
              <Label htmlFor="provider-account-method">
                {t("accounts.authMethod")}
              </Label>
              <Select
                value={method}
                onValueChange={(value) => {
                  setMethod(value as ProviderAccountAuthMethod);
                  setApiKey("");
                }}
              >
                <SelectTrigger id="provider-account-method">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {methods.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(`accounts.methods.${option}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {method === "api_key" ? (
            <div className="space-y-2">
              <Label htmlFor="provider-account-key">
                {t("accounts.apiKey")}
              </Label>
              <Input
                id="provider-account-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {t([
                  `accounts.connect.${providerId}.keyHint`,
                  "accounts.apiBillingHint",
                ])}
              </p>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="break-words text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setApiKey("");
              onClose();
            }}
          >
            {t("accounts.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={
              busy || !label.trim() || (method === "api_key" && !apiKey.trim())
            }
            onClick={() => void save()}
          >
            {busy
              ? t("accounts.saving")
              : account
                ? t("accounts.signIn")
                : method === "oauth"
                  ? t("accounts.addAndSignIn")
                  : t("accounts.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
