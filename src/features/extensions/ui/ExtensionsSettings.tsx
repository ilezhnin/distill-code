import { useProjectStore } from "@/features/projects/stores/projectStore";
import { McpManager } from "./McpManager";

/** Manage Flock connections and the MCP configurations of local providers. */
export function ExtensionsSettings() {
  const activeProject = useProjectStore((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  );
  const workspacePaths = activeProject?.workingDirs ?? [];

  return <McpManager workspacePaths={workspacePaths} />;
}
