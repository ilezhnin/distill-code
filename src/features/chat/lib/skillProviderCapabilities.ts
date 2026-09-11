export type SkillActivationStyle = "codex" | "claude" | "gemini" | "standard";

export interface SkillProviderCapabilities {
  supportsSkillDiscovery: boolean;
  supportsSkillMentions: boolean;
  activationStyle: SkillActivationStyle;
}

/** How a harness expects skill instructions to be phrased. */
export function getSkillProviderCapabilities(
  providerId: string | null | undefined,
): SkillProviderCapabilities {
  const normalizedProviderId = providerId?.toLowerCase() ?? "";
  const activationStyle = normalizedProviderId.includes("codex")
    ? "codex"
    : normalizedProviderId.includes("claude")
      ? "claude"
      : normalizedProviderId.includes("gemini")
        ? "gemini"
        : "standard";

  return {
    supportsSkillDiscovery: true,
    supportsSkillMentions: true,
    activationStyle,
  };
}
