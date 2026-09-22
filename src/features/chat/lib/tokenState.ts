import type { TokenState } from "@/shared/types/chat";

/** Apply one usage update, preserving omitted fields and explicit cost resets. */
export function mergeTokenState(
  current: TokenState,
  partial: Partial<TokenState>,
): TokenState {
  const inputTokens = partial.inputTokens ?? current.inputTokens;
  const outputTokens = partial.outputTokens ?? current.outputTokens;
  const accumulatedInput =
    partial.accumulatedInput ??
    current.accumulatedInput + (partial.inputTokens ?? 0);
  const accumulatedOutput =
    partial.accumulatedOutput ??
    current.accumulatedOutput + (partial.outputTokens ?? 0);
  const accumulatedCost =
    partial.accumulatedCost !== undefined
      ? partial.accumulatedCost
      : current.accumulatedCost;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    accumulatedInput,
    accumulatedOutput,
    accumulatedTotal:
      partial.accumulatedTotal ?? accumulatedInput + accumulatedOutput,
    contextLimit: partial.contextLimit ?? current.contextLimit,
    accumulatedCost,
    costBilling:
      accumulatedCost == null
        ? null
        : partial.costBilling !== undefined
          ? partial.costBilling
          : (current.costBilling ?? "estimate"),
  };
}
