/**
 * The header over a worker's brief: who this agent is and who sent it.
 *
 * An operator reaches a worker from a chip in the conductor's chat and lands
 * on a long instruction written for a model. The harnesses people work in
 * every day open a subagent's transcript with its metadata first — agent type,
 * nickname, model, the parent it reports to — and the brief under it. This is
 * that line: the role, the worker's name, the model and effort it runs at,
 * and the chat that started it, as the way back. The brief itself stays the
 * first user message, folded to a few lines, exactly as it was sent.
 */

import { useTranslation } from "react-i18next";
import { IconArrowBackUp, IconRobot } from "@tabler/icons-react";

import { splitLegacyFoldedModelId } from "@/shared/lib/foldedModelId";
import { Button } from "@/shared/ui/button";

import { roleDisplayName } from "../roleLayers";
import type { SessionNode } from "../types";
import type { WorkerBrief } from "../ConductorTranscriptContext";

/**
 * What the worker runs on, as the chip under the plan says it: the model, the
 * effort and fast mode, as separate words. A node recorded with the effort
 * folded into its model id is shown split, so the header never names an id no
 * harness lists; the node's own `effort` wins over the folded one, as it does
 * at the spawn.
 */
export function workerRunLabel(
  node: Pick<SessionNode, "modelId" | "effort" | "fast">,
  fastLabel: string,
): string | undefined {
  const folded = node.modelId ? splitLegacyFoldedModelId(node.modelId) : null;
  const parts = [
    folded ? folded.modelId : node.modelId,
    node.effort ?? folded?.effort,
    node.fast ? fastLabel : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The role line: the catalog's name for the worker's role, or nothing when
 * the node carries no role id (a hand-started orchestrator, a chat registered
 * from the CLI). The role is not the same thing as the display name — three
 * parallel "Scout · waveEngine" workers share one role — so both are shown
 * when they differ, and the name alone when the role is all it is.
 */
export function workerRoleLabel(
  node: Pick<SessionNode, "roleId" | "displayName">,
): string | undefined {
  if (!node.roleId) return undefined;
  const role = roleDisplayName(node.roleId);
  return role === node.displayName ? undefined : role;
}

export function WorkerBriefHeader({ node, parent, onOpenParent }: WorkerBrief) {
  const { t } = useTranslation("chat");
  const role = workerRoleLabel(node);
  const run = workerRunLabel(node, t("conductor.chipFast"));
  const sentBy = parent
    ? t("conductor.brief.startedBy", { name: parent.displayName })
    : t("conductor.brief.startedByAnotherChat");
  return (
    <div
      data-role="worker-brief-header"
      className="mb-1.5 flex min-w-0 flex-col gap-0.5 text-xs leading-4 text-muted-foreground"
    >
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <IconRobot aria-hidden className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground">{node.displayName}</span>
        {role ? <span>· {role}</span> : null}
        {run ? (
          <span data-role="worker-brief-run" className="italic">
            · {run}
          </span>
        ) : null}
      </p>
      <p className="flex min-w-0 flex-wrap items-center gap-x-1.5">
        <span>{t("conductor.brief.title")}</span>
        <span>·</span>
        {parent && onOpenParent ? (
          <Button
            type="button"
            variant="ghost"
            flush
            size="xs"
            data-testid="worker-brief-open-parent"
            className="h-auto px-0 py-0 text-xs font-normal text-muted-foreground hover:text-foreground"
            leftIcon={<IconArrowBackUp aria-hidden className="size-3.5" />}
            onClick={onOpenParent}
          >
            {sentBy}
          </Button>
        ) : (
          <span>{sentBy}</span>
        )}
      </p>
    </div>
  );
}
