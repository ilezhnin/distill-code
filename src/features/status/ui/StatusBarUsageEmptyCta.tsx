import { BarChart3, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/ui/button";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/shared/ui/hover-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { getProviderIcon } from "@/shared/ui/icons/ProviderIcons";
import { TRACKED_AGENT_PLATFORM_IDS } from "../lib/rateLimitTypes";

export function StatusBarUsageEmptyCta({
  onConnect,
  onHide,
}: {
  onConnect: () => void;
  onHide: () => void;
}) {
  const { t } = useTranslation("status");

  return (
    <HoverCard openDelay={150} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          onClick={onConnect}
          aria-label={t("bar.configureUsage")}
          className="inline-flex h-5 cursor-pointer items-center gap-1.5 rounded px-1.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
        >
          <BarChart3 className="size-3.5" />
          <span>{t("bar.configureUsage")}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[260px] p-2.5"
      >
        <div className="space-y-2 text-xs leading-[1.45]">
          <div className="flex items-start justify-between gap-2">
            <div className="font-semibold text-foreground">
              {t("bar.agentLimits")}
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onHide}
                  aria-label={t("bar.hide")}
                  className="-mr-1 -mt-0.5 inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
                >
                  <EyeOff className="size-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {t("bar.hide")}
              </TooltipContent>
            </Tooltip>
          </div>
          <p className="text-muted-foreground">{t("bar.connectDescription")}</p>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <span>{t("bar.supports")}:</span>
            {TRACKED_AGENT_PLATFORM_IDS.map((providerId) => (
              <span key={providerId}>
                {getProviderIcon(providerId, "size-3.5")}
              </span>
            ))}
          </div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={onConnect}
            className="mt-0.5 h-7 w-full text-xs"
          >
            {t("bar.connect")}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
