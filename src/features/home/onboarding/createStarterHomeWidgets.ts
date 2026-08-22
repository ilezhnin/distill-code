import type { WidgetInstance } from "@/features/home/widgets/types";
import type { Persona } from "@/shared/types/agents";

/** Builds the complete, canonical first-run/reset Home composition. */
export function createStarterHomeWidgets(
  _personas: readonly Persona[],
): WidgetInstance[] {
  return [];
}
