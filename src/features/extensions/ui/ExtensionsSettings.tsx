import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { PageHeader } from "@/shared/ui/page-shell";
import { SearchBar } from "@/shared/ui/SearchBar";
import { SettingsSections } from "@/shared/ui/settings-section";
import { LocalMcpSection } from "./LocalMcpSection";

/**
 * Settings page for the MCP servers the local harnesses know about. This is
 * what remains of the former Connections page once the Block-managed OAuth
 * connections were removed: one searchable inventory of local MCP servers,
 * grouped by harness.
 */
export function ExtensionsSettings() {
  const { t } = useTranslation("settings");
  const [searchTerm, setSearchTerm] = useState("");
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  );
  const workspacePaths = activeProject?.workingDirs ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t("nav.extensions")}
        description={t("extensions.description")}
        variant="default"
        titleClassName="font-medium"
        descriptionClassName="text-xs font-normal text-muted-foreground"
      />

      <SearchBar
        size="pill"
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t("connections.search")}
        aria-label={t("connections.search")}
      />

      <SettingsSections>
        <LocalMcpSection
          searchTerm={searchTerm}
          workspacePaths={workspacePaths}
        />
      </SettingsSections>
    </div>
  );
}
