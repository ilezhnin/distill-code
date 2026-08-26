/**
 * Read-only view of what an agent may actually do, for the agent detail
 * page.
 *
 * Same job as {@link AgentModelRankingSummary}: show the effective answer,
 * not the stored field. An agent with no `spawns` key is not an agent with
 * no spawn rules — it is an agent on its layer's defaults, and a page that
 * printed "not set" and stopped would leave the operator to guess which. So
 * each row shows what applies AND says where it came from: set on this
 * agent, or inherited from the role it runs as.
 *
 * The inherited case prints the whole per-layer table rather than picking
 * one, because a persona has no single layer — the same agent is an
 * orchestrator in one session and a worker in the next. Naming one default
 * would read better and be a lie.
 */

import { useTranslation } from "react-i18next";

import { cn } from "@/shared/lib/cn";
import type { Persona } from "@/shared/types/agents";

import {
  formatMemoryWriteDefaults,
  formatSpawnDefaults,
  formatSpawnLayerList,
} from "../lib/personaAclCopy";

const NOTE_CLASS = "text-[11px] leading-4 text-surface-agent-profile-fg-muted";

export interface AgentPermissionsSummaryProps {
  persona: Pick<Persona, "spawns" | "memoryWrite">;
}

export function AgentPermissionsSummary({
  persona,
}: AgentPermissionsSummaryProps) {
  const { t } = useTranslation("agents");

  const spawnsOverride = persona.spawns;
  const spawnsValue =
    spawnsOverride === undefined
      ? formatSpawnDefaults(t)
      : formatSpawnLayerList(t, spawnsOverride);

  const memoryValue =
    persona.memoryWrite === undefined
      ? formatMemoryWriteDefaults(t)
      : persona.memoryWrite
        ? t("acl.summary.memoryGranted")
        : t("acl.summary.memoryRefused");

  const rows = [
    {
      id: "spawns",
      caption: t("acl.summary.spawnsRow"),
      value: spawnsValue,
      inherited: spawnsOverride === undefined,
    },
    {
      id: "memory",
      caption: t("acl.summary.memoryRow"),
      value: memoryValue,
      inherited: persona.memoryWrite === undefined,
    },
  ];

  return (
    <div className="space-y-2" data-testid="agent-permissions-summary">
      {rows.map((row) => (
        <div key={row.id} data-testid={`agent-permissions-summary-${row.id}`}>
          {/* Caption on its own line: an inherited row's value is itself a
              layer-by-layer list with colons in it, and running the two
              together made the sentence unreadable. */}
          <p className="min-w-0 break-words">
            <span className={cn("block", NOTE_CLASS)}>{row.caption}</span>
            {row.value}
          </p>
          <p
            className={NOTE_CLASS}
            data-testid={`agent-permissions-summary-${row.id}-note`}
          >
            {row.inherited ? t("acl.summary.fromRole") : t("acl.summary.set")}
          </p>
        </div>
      ))}
    </div>
  );
}
