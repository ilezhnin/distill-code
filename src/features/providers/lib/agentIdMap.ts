import { resolveAgentProviderCatalogIdStrict } from "../providerCatalog";

export function crateCheckIdToProviderId(checkId: string): string | null {
  const prefix = "ai-agent-";
  if (!checkId.startsWith(prefix)) return null;
  return resolveAgentProviderCatalogIdStrict(checkId.slice(prefix.length));
}
