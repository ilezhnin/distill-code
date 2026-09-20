export type ProviderSetupMethod = "none" | "cli_auth";
export type ProviderGroup = "default" | "additional";

/** A curated ACP agent harness the app knows how to install, sign in, and run. */
export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  category: "agent";
  description: string;
  setupMethod: ProviderSetupMethod;
  group: ProviderGroup;
  aliases?: string[];
  /** Executable the doctor probes for; also what the host spawns. */
  binaryName?: string;
  docsUrl?: string;
  supportsInstall?: boolean;
  supportsAuth?: boolean;
  supportsAuthStatus?: boolean;
  /** Known non-interactive logout command; the card offers Sign out. */
  supportsLogout?: boolean;
  /** The bridge vendors the full harness CLI, so it is the only binary. */
  bundledBridge?: boolean;
  /** False when the harness manages its model list outside the app. */
  supportsModelList?: boolean;
  modelSelectionHint?: string;
}

export type ProviderSetupStatus =
  | "built_in"
  | "connected"
  | "configured"
  | "not_installed"
  | "not_configured"
  | "installing"
  | "authenticating"
  | "error";

export interface ProviderDisplayInfo extends ProviderCatalogEntry {
  status: ProviderSetupStatus;
}
