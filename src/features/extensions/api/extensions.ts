import { getClient } from "@/shared/api/acpConnection";
import type { McpExtensionEntry } from "@/shared/api/hostTypes";
import type { ExtensionConfig, ExtensionEntry } from "../types";

/**
 * The host stores extension configs verbatim, so the wire shape is the
 * extension config itself plus the config key and enabled flag.
 */
function toExtensionEntry(entry: McpExtensionEntry): ExtensionEntry {
  const extension = entry.extension as ExtensionConfig;
  return {
    ...extension,
    config_key: entry.configKey ?? extension.name,
    enabled: entry.enabled,
    configurationRevision: entry.configurationRevision,
  };
}

export async function listExtensions(): Promise<ExtensionEntry[]> {
  const client = await getClient();
  const response = await client.host.configExtensionsList({});
  return response.extensions.map(toExtensionEntry);
}

export async function saveExtension(
  extension: ExtensionConfig,
  enabled = true,
): Promise<void> {
  const client = await getClient();
  await client.host.configExtensionsAdd({
    extension: { ...extension },
    enabled,
  });
}

export async function setExtensionEnabled(
  configKey: string,
  enabled: boolean,
): Promise<void> {
  const client = await getClient();
  await client.host.configExtensionsSetEnabled({ configKey, enabled });
}

export async function removeExtension(configKey: string): Promise<void> {
  const client = await getClient();
  await client.host.configExtensionsRemove({ configKey });
}
