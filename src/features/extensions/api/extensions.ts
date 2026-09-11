import { getClient } from "@/shared/api/acpConnection";
import type { McpExtension, McpExtensionEntry } from "@/shared/api/hostTypes";
import type { ExtensionConfig, ExtensionEntry } from "../types";

/**
 * The host stores extension configs verbatim, so the wire shape is the
 * settings form's own shape plus the config key and enabled flag.
 */
function toExtensionEntry(entry: McpExtensionEntry): ExtensionEntry {
  const extension = entry.extension as ExtensionConfig;
  return {
    ...extension,
    config_key: entry.configKey ?? extension.name,
    enabled: entry.enabled,
  };
}

export async function listExtensions(): Promise<ExtensionEntry[]> {
  const client = await getClient();
  const response = await client.host.configExtensionsList({});
  return response.extensions.map(toExtensionEntry);
}

export async function addExtension(
  name: string,
  extensionConfig: ExtensionConfig,
  enabled = false,
): Promise<void> {
  const client = await getClient();
  const extension: McpExtension = { ...extensionConfig, name };
  await client.host.configExtensionsAdd({ extension, enabled });
}

export async function removeExtension(configKey: string): Promise<void> {
  const client = await getClient();
  await client.host.configExtensionsRemove({ configKey });
}

export async function toggleExtension(
  configKey: string,
  enabled: boolean,
): Promise<void> {
  const client = await getClient();
  await client.host.configExtensionsSetEnabled({
    configKey,
    enabled,
  });
}
