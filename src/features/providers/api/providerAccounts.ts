import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderCreditBalance } from "@/features/status/lib/rateLimitTypes";

export type ProviderAccountAuthMethod = "oauth" | "api_key";

/**
 * How a provider's accounts are connected. It names the flow the app already
 * runs for the provider: a browser sign-in of its CLI or a saved key for the
 * accounts Flock stores, or the one sign-in the harness CLI keeps itself.
 */
export type ProviderConnectionFlow = "browser_or_api_key" | "api_key" | "cli";

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  authMethod: ProviderAccountAuthMethod;
  enabled: boolean;
  autoSwitch: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * One provider as Settings shows it: the same fields for every harness, with
 * the differences between them as data, and its accounts as a list.
 */
export interface ProviderAccountModel {
  providerId: string;
  connection: ProviderConnectionFlow;
  /** The most accounts the provider can hold, or null for any number. */
  accountLimit: number | null;
  /** Whether the provider's status adapter reports plan and usage windows. */
  reportsUsage: boolean;
  /** Whether Flock can sign an account of this provider out. */
  supportsSignOut: boolean;
  accounts: ProviderAccount[];
  defaultAccountId: string | null;
  automaticSwitching: boolean;
}

export interface ProviderAccountsSnapshot {
  providers: ProviderAccountModel[];
  accounts: ProviderAccount[];
  defaults: Record<string, string>;
  automaticSwitching: Record<string, boolean>;
}

export interface ProviderAccountLimit {
  id: string;
  label: string;
  usedPercent: number | null;
  remaining: number | null;
  resetsAt: number | null;
  windowMinutes?: number | null;
  modelId: string | null;
  /** The account's credits keep it usable once this plan window is spent. */
  coveredByCredits?: boolean;
  /** A monthly window that meters coding use alone (Kimi Code). */
  coding?: boolean;
}

export interface ProviderAccountResetCredit {
  id: string;
  resetType: string;
  status: string;
  grantedAt: number | null;
  expiresAt: number | null;
  title: string | null;
  description: string | null;
}

export type ProviderAccountState =
  | "ready"
  | "limited"
  | "needs_auth"
  | "unknown"
  | "error"
  | "disabled";

export interface ProviderAccountStatus {
  accountId: string;
  providerId: string;
  state: ProviderAccountState;
  subscription: string | null;
  accountLabel: string | null;
  limits: ProviderAccountLimit[];
  resetTokens: {
    available: number;
    expiresAt: number | null;
    supported: boolean;
    credits?: ProviderAccountResetCredit[] | null;
  } | null;
  credits: ProviderCreditBalance[] | null;
  /** Plan usage is spent and the account runs on its credits. */
  onCredits?: boolean;
  lastUpdatedAt: number;
  lastAttemptAt: number;
  stale: boolean;
  error: string | null;
  usageRetryAt?: number | null;
  /**
   * The provider refuses this account's requests for a reason no usage reset
   * lifts, in its own words; usage windows may still show room.
   */
  refused?: string | null;
}

export interface ProviderAccountStatuses {
  accounts: ProviderAccountStatus[];
  updatedAt: number;
}

export interface ProviderAccountAuthState {
  accountId: string;
  attemptId?: string;
  status: "running" | "authenticated" | "needs_auth" | "error";
  message: string;
}

export interface AddProviderAccount {
  providerId: string;
  label: string;
  authMethod: ProviderAccountAuthMethod;
  apiKey?: string;
}

export async function listProviderAccounts(): Promise<ProviderAccountsSnapshot> {
  return invoke("list_provider_accounts");
}

export async function getProviderAccountStatuses(
  force = false,
): Promise<ProviderAccountStatuses> {
  return invoke("get_provider_account_statuses", { force });
}

export function addProviderAccount(
  input: AddProviderAccount,
): Promise<ProviderAccount> {
  return invoke("add_provider_account", { ...input });
}

export function updateProviderAccount(
  accountId: string,
  patch: {
    label?: string;
    apiKey?: string;
  },
): Promise<ProviderAccount> {
  return invoke("update_provider_account", { accountId, ...patch });
}

export function removeProviderAccount(
  accountId: string,
): Promise<ProviderAccountsSnapshot> {
  return invoke("remove_provider_account", { accountId });
}

export function setDefaultProviderAccount(
  providerId: string,
  accountId: string,
): Promise<ProviderAccountsSnapshot> {
  return invoke("set_default_provider_account", { providerId, accountId });
}

export function setProviderAccountRouting(
  providerId: string,
  automaticSwitching: boolean,
): Promise<ProviderAccountsSnapshot> {
  return invoke("set_provider_account_routing", {
    providerId,
    automaticSwitching,
  });
}

export function authenticateProviderAccount(
  accountId: string,
  force = false,
  attemptId?: string,
): Promise<ProviderAccountAuthState> {
  return invoke("authenticate_provider_account", {
    accountId,
    force,
    attemptId,
  });
}

export function cancelProviderAccountAuthentication(
  accountId: string,
  attemptId?: string,
): Promise<void> {
  return invoke("cancel_provider_account_authentication", {
    accountId,
    attemptId,
  });
}

export function signOutProviderAccount(accountId: string): Promise<void> {
  return invoke("sign_out_provider_account", { accountId });
}

export type AccountResetOutcome =
  | "reset"
  | "alreadyRedeemed"
  | "nothingToReset"
  | "noCredit";

export function consumeProviderAccountReset(
  accountId: string,
  idempotencyKey: string,
  creditId?: string,
): Promise<{ outcome: AccountResetOutcome }> {
  return invoke("consume_provider_account_reset", {
    accountId,
    idempotencyKey,
    ...(creditId ? { creditId } : {}),
  });
}

export function onProviderAccountsChanged(callback: () => void) {
  return listen("provider-accounts-changed", callback);
}

export function onProviderAccountStatuses(
  callback: (snapshot: ProviderAccountStatuses) => void,
) {
  return listen<ProviderAccountStatuses>("provider-account-statuses", (event) =>
    callback(event.payload),
  );
}

export function onProviderAccountAuthState(
  callback: (state: ProviderAccountAuthState) => void,
) {
  return listen<ProviderAccountAuthState>(
    "provider-account-auth-state",
    (event) => callback(event.payload),
  );
}
