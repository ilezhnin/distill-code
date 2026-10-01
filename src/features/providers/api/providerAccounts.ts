import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const MANAGED_ACCOUNT_PROVIDERS = ["codex-acp", "claude-acp"] as const;

export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  authMethod: "oauth" | "api_key";
  enabled: boolean;
  autoSwitch: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderAccountsSnapshot {
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
}

export interface ProviderAccountStatus {
  accountId: string;
  providerId: string;
  state: "ready" | "limited" | "needs_auth" | "unknown" | "error" | "disabled";
  subscription: string | null;
  accountLabel: string | null;
  limits: ProviderAccountLimit[];
  resetTokens: {
    available: number;
    expiresAt: number | null;
    supported: boolean;
    credits?: Array<{
      id: string;
      resetType: string;
      status: string;
      grantedAt: number | null;
      expiresAt: number | null;
      title: string | null;
      description: string | null;
    }> | null;
  } | null;
  credits: { balance: string | null; unlimited: boolean } | null;
  lastUpdatedAt: number;
  lastAttemptAt: number;
  stale: boolean;
  error: string | null;
}

export interface ProviderAccountStatuses {
  accounts: ProviderAccountStatus[];
  updatedAt: number;
}

export interface ProviderAccountAuthState {
  accountId: string;
  status: "running" | "authenticated" | "needs_auth" | "error";
  message: string;
}

export interface AddProviderAccount {
  providerId: string;
  label: string;
  authMethod: "oauth" | "api_key";
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
): Promise<ProviderAccountAuthState> {
  return invoke("authenticate_provider_account", { accountId, force });
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
): Promise<{ outcome: AccountResetOutcome }> {
  return invoke("consume_provider_account_reset", {
    accountId,
    idempotencyKey,
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
