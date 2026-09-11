import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppearanceSettings } from "./AppearanceSettings";
import { ArchiveSettings } from "./ArchiveSettings";
import { MemorySettings } from "@/features/memory/ui/MemorySettings";
import { BehaviorSettings } from "./BehaviorSettings";
import { ProvidersSettings } from "./ProvidersSettings";
import { NotificationSettings } from "./NotificationSettings";
import { SecuritySettings } from "./SecuritySettings";
import { StatsSettings } from "./StatsSettings";
import { SystemSettings } from "./SystemSettings";
import type { SectionId } from "./settingsSections";
import { KeyboardShortcutsSettings } from "@/features/shortcuts/ui/KeyboardShortcutsSettings";
import { ExtensionsSettings } from "@/features/extensions/ui/ExtensionsSettings";
import { SettingsPane } from "@/shared/ui/SettingsPage";
import type { AgentSetupTroubleshootingRequest } from "@/features/providers/lib/agentSetupTroubleshooting";
import { refreshDoctorReportFreshness } from "@/shared/api/useDoctorReport";
import { useProfileCapability } from "@/shared/profile/capabilities";

interface SettingsViewProps {
  activeSection: SectionId;
  onStartTroubleshootingChat?: (
    request: AgentSetupTroubleshootingRequest,
  ) => void;
}

// Rev 3 (Aug 10): "general" split into appearance/chat/system/about (see
// settingsSections.ts for the full rationale). Security is permanent and
// ungated.
//
// Rev 5 (Aug 19): "about" is no longer a routable section -- its content
// (app identity, Account, and the embedded Updates card) moved into
// SystemSettings.tsx, under an "About" subhead at the bottom of the page.
//
// Rev 4: Doctor is no longer a routable settings section at all -- it opens
// as a dialog from a row inside SystemSettings.tsx instead (see
// SystemSettings.tsx and DoctorSettings.tsx for the rationale). SettingsView
// still warms the shared doctor report on every Settings visit below, since
// the AI providers page and the Doctor dialog both read that same cache.
export function SettingsView({
  activeSection,
  onStartTroubleshootingChat,
}: SettingsViewProps) {
  const queryClient = useQueryClient();
  const doctorEnabled = useProfileCapability("doctor");

  // Warm the shared doctor report once per Settings visit. SettingsView mounts
  // whenever Settings opens (every entry path: sidebar, restored URL, returning
  // from design-system), so the Doctor and AI providers detail pages consume an
  // already-warming cache instead of each kicking off its own `run_doctor`.
  //
  // `refreshDoctorReportFreshness` first runs the fast, offline status read
  // (`ensureQueryData`, deduped + staleTime-respecting, so a re-open within the
  // window is a no-op) to paint immediately, then runs the slower
  // network-touching freshness pass off that path and seeds version/update
  // badges into the same cache entry without blocking first paint.
  useEffect(() => {
    if (!doctorEnabled) {
      return;
    }
    void refreshDoctorReportFreshness(queryClient);
  }, [doctorEnabled, queryClient]);

  return (
    <SettingsPane>
      {activeSection === "appearance" && <AppearanceSettings />}
      {activeSection === "behavior" && <BehaviorSettings />}
      {activeSection === "extensions" && <ExtensionsSettings />}
      {activeSection === "providers" && (
        <ProvidersSettings
          onStartTroubleshootingChat={onStartTroubleshootingChat}
        />
      )}
      {activeSection === "notifications" && <NotificationSettings />}
      {activeSection === "shortcuts" && <KeyboardShortcutsSettings />}
      {activeSection === "stats" && <StatsSettings />}
      {activeSection === "memory" && <MemorySettings />}
      {activeSection === "archive" && <ArchiveSettings />}
      {activeSection === "security" && <SecuritySettings />}
      {activeSection === "system" && <SystemSettings />}
    </SettingsPane>
  );
}
