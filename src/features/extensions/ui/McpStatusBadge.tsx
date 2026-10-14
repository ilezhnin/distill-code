import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/ui/badge";
import type { McpCheckResult } from "../api/mcpManager";

export function McpStatusBadge({
  enabled,
  diagnostic,
}: {
  enabled: boolean;
  diagnostic?: McpCheckResult;
}) {
  const { t } = useTranslation("settings");
  const status = enabled ? (diagnostic?.status ?? "notChecked") : "disabled";
  return (
    <Badge
      variant={
        status === "error" || status === "needsAuth"
          ? "destructive"
          : "secondary"
      }
    >
      {t(`mcpManager.status.${status}`)}
    </Badge>
  );
}
