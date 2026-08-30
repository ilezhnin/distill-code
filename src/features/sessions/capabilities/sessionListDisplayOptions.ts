/**
 * Display-option validation for the sidebar session list.
 *
 * Lives beside the capability rather than inside it so the capability module
 * exports components only. A module that mixes a component with a plain
 * function loses react-refresh: vite invalidates it instead of hot-swapping,
 * which drops the renderer's in-memory session state mid-edit.
 */

export type SessionListDisplayOptions = {
  projectShowChatIcons: boolean;
  projectShowTimestamps: boolean;
  chatShowChatIcons: boolean;
  chatShowTimestamps: boolean;
};

export function validateDisplayOptions(
  value: unknown,
  defaults: SessionListDisplayOptions,
): SessionListDisplayOptions {
  if (!value || typeof value !== "object") return defaults;
  const parsed = value as Partial<
    Record<keyof SessionListDisplayOptions, unknown>
  > & {
    showChatIcons?: unknown;
    showTimestamps?: unknown;
    showProjectChatIcons?: unknown;
    showProjectTimestamps?: unknown;
  };
  const legacyShowChatIcons =
    typeof parsed.showChatIcons === "boolean" ? parsed.showChatIcons : null;
  const legacyShowTimestamps =
    typeof parsed.showTimestamps === "boolean" ? parsed.showTimestamps : null;
  const booleanOption = (
    value: unknown,
    legacy: boolean | null,
    fallback: boolean,
  ) => (typeof value === "boolean" ? value : (legacy ?? fallback));
  return {
    projectShowChatIcons: booleanOption(
      parsed.projectShowChatIcons,
      typeof parsed.showProjectChatIcons === "boolean"
        ? parsed.showProjectChatIcons
        : legacyShowChatIcons,
      defaults.projectShowChatIcons,
    ),
    projectShowTimestamps: booleanOption(
      parsed.projectShowTimestamps,
      typeof parsed.showProjectTimestamps === "boolean"
        ? parsed.showProjectTimestamps
        : legacyShowTimestamps,
      defaults.projectShowTimestamps,
    ),
    chatShowChatIcons: booleanOption(
      parsed.chatShowChatIcons,
      legacyShowChatIcons,
      defaults.chatShowChatIcons,
    ),
    chatShowTimestamps: booleanOption(
      parsed.chatShowTimestamps,
      legacyShowTimestamps,
      defaults.chatShowTimestamps,
    ),
  };
}
