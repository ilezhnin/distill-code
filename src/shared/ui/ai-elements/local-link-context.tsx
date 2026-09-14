import { createContext, useContext } from "react";

/**
 * How a surface opens a local Markdown destination — a filesystem path such as
 * `report.md`, `./out/diagram.png` or `C:\repo\notes.md`.
 *
 * `MarkdownLink` always cancels the browser's own navigation for these (see
 * there for why) and then calls this, so a surface that does not provide a
 * handler renders local links as inert text rather than opening a dead tab.
 * Chat provides one from `ArtifactPolicyProvider`, which resolves the path
 * against the session working directory and applies the open gate; the message
 * bubble narrows it further so a failure is reported inside the bubble.
 */
export type OpenLocalMarkdownLink = (href: string) => void;

const LocalMarkdownLinkContext = createContext<OpenLocalMarkdownLink | null>(
  null,
);

export const LocalMarkdownLinkProvider = LocalMarkdownLinkContext.Provider;

export function useOpenLocalMarkdownLink(): OpenLocalMarkdownLink | null {
  return useContext(LocalMarkdownLinkContext);
}
