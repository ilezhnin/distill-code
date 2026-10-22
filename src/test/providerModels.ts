import type {
  ProviderAccount,
  ProviderAccountModel,
  ProviderConnectionFlow,
} from "@/features/providers/api/providerAccounts";

/** The connection flow each curated harness uses, as the host lists it. */
export const PROVIDER_CONNECTIONS: Record<string, ProviderConnectionFlow> = {
  "claude-acp": "browser_or_api_key",
  "codex-acp": "browser_or_api_key",
  "zai-acp": "api_key",
  "grok-acp": "cli",
  "kimi-acp": "cli",
  "copilot-acp": "cli",
  "amp-acp": "cli",
};

const REPORTS_USAGE = new Set([
  "claude-acp",
  "codex-acp",
  "zai-acp",
  "grok-acp",
  "kimi-acp",
]);
const SIGNS_OUT = new Set([
  "claude-acp",
  "codex-acp",
  "zai-acp",
  "grok-acp",
  "kimi-acp",
]);

/** The fixed identity the host names a provider's CLI sign-in with. */
export function cliLoginAccount(providerId: string): ProviderAccount {
  return {
    id: `cli-login-${providerId}`,
    providerId,
    label: `${providerId} CLI sign-in`,
    authMethod: "oauth",
    enabled: true,
    autoSwitch: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * The provider models the host would list for `accounts`: one entry per
 * provider named, in that order, with a CLI provider carrying its own
 * sign-in identity as its one account.
 */
export function providerModels(
  providerIds: readonly string[],
  accounts: readonly ProviderAccount[],
  defaults: Record<string, string> = {},
  automaticSwitching: Record<string, boolean> = {},
): ProviderAccountModel[] {
  return providerIds.map((providerId) => {
    const connection = PROVIDER_CONNECTIONS[providerId] ?? "browser_or_api_key";
    const own =
      connection === "cli"
        ? [cliLoginAccount(providerId)]
        : accounts.filter((account) => account.providerId === providerId);
    return {
      providerId,
      connection,
      accountLimit: connection === "cli" ? 1 : null,
      reportsUsage: REPORTS_USAGE.has(providerId),
      supportsSignOut: SIGNS_OUT.has(providerId),
      accounts: own,
      defaultAccountId:
        connection === "cli"
          ? own[0].id
          : (defaults[providerId] ?? own[0]?.id ?? null),
      automaticSwitching:
        connection === "cli"
          ? false
          : (automaticSwitching[providerId] ?? false),
    };
  });
}

/** The accounts-store state fields the models imply. */
export function providerModelState(models: ProviderAccountModel[]) {
  return {
    providers: models,
    providersById: Object.fromEntries(
      models.map((model) => [model.providerId, model]),
    ),
    accounts: models.flatMap((model) => model.accounts),
    defaults: Object.fromEntries(
      models.flatMap((model) =>
        model.defaultAccountId
          ? [[model.providerId, model.defaultAccountId]]
          : [],
      ),
    ),
    automaticSwitching: Object.fromEntries(
      models.map((model) => [model.providerId, model.automaticSwitching]),
    ),
  };
}
