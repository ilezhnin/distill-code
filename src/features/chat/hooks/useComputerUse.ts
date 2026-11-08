import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { readComputerUse, setComputerUse } from "@/shared/api/acpApi";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";

interface ComputerUseControl {
  /** The host has said whether this chat has computer use on. */
  known: boolean;
  enabled: boolean;
  /** A change for this chat is on its way, such as the first driver download. */
  pending: boolean;
  toggle: () => Promise<void>;
}

/**
 * A chat's computer use switch. The host owns the value: it is read for the
 * chat on mount and taken from the host's answer after every change, so the
 * control never shows a state the next agent session will not have.
 */
export function useComputerUse(
  sessionId: string | undefined,
): ComputerUseControl {
  const { t } = useTranslation("chat");
  const [stored, setStored] = useState<{
    sessionId: string;
    enabled: boolean;
  } | null>(null);
  const [pendingFor, setPendingFor] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    readComputerUse(sessionId)
      .then((state) => {
        if (!cancelled) setStored({ sessionId, enabled: state.enabled });
      })
      .catch(() => {
        // A host without computer use has no switch to show.
        if (!cancelled) setStored(null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const known = sessionId !== undefined && stored?.sessionId === sessionId;
  const enabled = known && stored.enabled;
  const pending = sessionId !== undefined && pendingFor === sessionId;

  const toggle = useCallback(async () => {
    if (!sessionId || pendingFor === sessionId) return;
    const next = !enabled;
    setPendingFor(sessionId);
    try {
      const state = await setComputerUse(sessionId, next);
      setStored({ sessionId, enabled: state.enabled });
    } catch (error) {
      toast.error(
        next
          ? t("toolbar.computerUseEnableFailed")
          : t("toolbar.computerUseDisableFailed"),
        { description: formatAcpErrorMessage(error) },
      );
    } finally {
      setPendingFor((current) => (current === sessionId ? null : current));
    }
  }, [enabled, pendingFor, sessionId, t]);

  return { known, enabled, pending, toggle };
}
