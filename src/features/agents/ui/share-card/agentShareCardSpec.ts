import { segmentCardGraphemes } from "./agentShareCardText";
import {
  AGENT_CARD_ASPECT_RATIO,
  AGENT_CARD_GEOMETRY,
} from "./agentShareCardGeometry";

export const AGENT_CARD_WIDTH = AGENT_CARD_GEOMETRY.width;
export const AGENT_CARD_HEIGHT = AGENT_CARD_GEOMETRY.height;
export { AGENT_CARD_ASPECT_RATIO };

const MAX_TITLE_GRAPHEMES = 26;
const CARD_MATCH_LOCALE = "en";

export function truncateAgentCardTitle(
  name: string,
  locale = CARD_MATCH_LOCALE,
): string {
  const title = name.trim().toLocaleUpperCase(locale) || "DISTILL AGENT";
  const graphemes = segmentCardGraphemes(title, locale);
  return graphemes.length > MAX_TITLE_GRAPHEMES
    ? `${graphemes.slice(0, MAX_TITLE_GRAPHEMES - 1).join("")}…`
    : title;
}
