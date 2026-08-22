import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { resolveAgentIcon } from "@/features/agents/lib/resolveAgentIcon";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { cn } from "@/shared/lib/cn";
import type { Persona } from "@/shared/types/agents";

export function ConductorAgentPickerDialog({
  open,
  personas,
  defaultPersonaId,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  personas: readonly Persona[];
  defaultPersonaId?: string | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (persona: Persona | null) => void;
}) {
  const { t } = useTranslation("chat");
  const [selectedId, setSelectedId] = useState<string | null>(
    defaultPersonaId ?? null,
  );

  useEffect(() => {
    if (open) {
      setSelectedId(defaultPersonaId ?? personas[0]?.id ?? null);
    }
  }, [defaultPersonaId, open, personas]);

  const selected = useMemo(
    () => personas.find((persona) => persona.id === selectedId) ?? null,
    [personas, selectedId],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" data-testid="conductor-agent-picker">
        <DialogHeader>
          <DialogTitle>{t("conductor.pickAgentTitle")}</DialogTitle>
          <DialogDescription>
            {t("conductor.pickAgentDescription")}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-1">
          {personas.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("conductor.pickAgentEmpty")}
            </p>
          ) : (
            personas.map((persona) => {
              const active = persona.id === selectedId;
              return (
                <button
                  key={persona.id}
                  type="button"
                  data-testid="conductor-agent-option"
                  aria-pressed={active}
                  onClick={() => setSelectedId(persona.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-md px-3 py-2 text-left hover:bg-muted/60",
                    active && "bg-muted",
                  )}
                >
                  <img
                    src={
                      typeof persona.avatar === "string" &&
                      (persona.avatar.startsWith("http") ||
                        persona.avatar.startsWith("data:"))
                        ? persona.avatar
                        : resolveAgentIcon(persona.id)
                    }
                    alt=""
                    className="size-8 shrink-0 rounded-md object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {persona.displayName}
                    </span>
                    {persona.sourceDescription ? (
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                        {persona.sourceDescription}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t("conductor.pickAgentCancel")}
          </Button>
          <Button
            type="button"
            data-testid="conductor-agent-picker-confirm"
            onClick={() => onConfirm(selected)}
          >
            {t("conductor.pickAgentConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
