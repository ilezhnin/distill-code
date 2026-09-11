const DEFAULT_LABEL_SUFFIX = " (Default)";

export function getChatInputAgentLabel(
  personaDisplayName: string | undefined,
  providerDisplayName: string,
): string {
  if (personaDisplayName) {
    return personaDisplayName;
  }

  return providerDisplayName.endsWith(DEFAULT_LABEL_SUFFIX)
    ? providerDisplayName.slice(0, -DEFAULT_LABEL_SUFFIX.length)
    : providerDisplayName;
}

export function getChatInputPlaceholder(
  t: (key: string, options?: { agent: string }) => string,
  agent: string,
  override?: string,
): string {
  if (override) return override;
  return t("input.placeholder", { agent });
}
