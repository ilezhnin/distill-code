import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  IconArrowDownToArc,
  IconChevronDown,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { toast } from "sonner";
import { useProjectStore } from "@/features/projects/stores/projectStore";
import { selectProjects } from "@/features/projects/stores/projectSelectors";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { PageShell } from "@/shared/ui/page-shell";
import { PageToolbarButton } from "@/shared/ui/page-toolbar-button";
import { SearchBar } from "@/shared/ui/SearchBar";
import { revealInFileManager } from "@/shared/lib/fileManager";
import { useSkillImportExport } from "../hooks/useSkillImportExport";
import { SkillDetailPage } from "./SkillDetailPage";
import { SkillsDialogs } from "./SkillsDialogs";
import { SkillsGrid } from "./SkillsGrid";
import { hydrateProjectNames } from "../lib/projectHydration";
import { listenSkillsChanged } from "../lib/skillsEvents";
import type { AppNavigationUpdateOptions } from "@/app/types/appNavigation";
import {
  deleteSkill,
  listSkills,
  type EditingSkill,
  type SkillInfo,
} from "../api/skills";

interface SkillsViewProps {
  activeSkillId?: string | null;
  onActiveSkillIdChange?: (
    skillId: string | null,
    options?: AppNavigationUpdateOptions,
  ) => void;
  onBreadcrumbLabelChange?: (label: string | null) => void;
  onStartChatWithSkill?: (skill: SkillInfo, projectId?: string | null) => void;
}

type SkillScope = "all" | "global" | `project:${string}`;

function skillMatchesQuery(skill: SkillInfo, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [
    skill.name,
    skill.description,
    skill.sourceLabel,
    ...skill.projectLinks.map((project) => project.name),
  ].some((field) => field.toLowerCase().includes(normalizedQuery));
}

function skillMatchesScope(skill: SkillInfo, scope: SkillScope): boolean {
  if (scope === "all") {
    return true;
  }
  if (scope === "global") {
    return skill.sourceKind === "global";
  }
  const projectId = scope.replace(/^project:/, "");
  return skill.projectLinks.some((project) => project.id === projectId);
}

function getPrimaryProjectLink(skill: SkillInfo) {
  return skill.projectLinks[0] ?? null;
}

function getProjectLinkForScope(
  skill: SkillInfo,
  selectedProjectId: string | null,
) {
  if (!selectedProjectId) {
    return getPrimaryProjectLink(skill);
  }

  return (
    skill.projectLinks.find((project) => project.id === selectedProjectId) ??
    getPrimaryProjectLink(skill)
  );
}

function resolveSkillForProjectScope(
  skill: SkillInfo,
  selectedProjectId: string | null,
): SkillInfo {
  if (skill.sourceKind !== "project") {
    return skill;
  }

  const projectLink = getProjectLinkForScope(skill, selectedProjectId);
  if (!projectLink) {
    return skill;
  }

  return {
    ...skill,
    path: projectLink.path,
    fileLocation: projectLink.fileLocation,
    sourceLabel: projectLink.name,
  };
}

function resolveSkillForPath(skill: SkillInfo, path: string): SkillInfo {
  if (skill.sourceKind !== "project") {
    return skill;
  }

  const projectLink = skill.projectLinks.find(
    (project) => project.path === path,
  );
  if (!projectLink) {
    return skill;
  }

  return {
    ...skill,
    path: projectLink.path,
    fileLocation: projectLink.fileLocation,
    sourceLabel: projectLink.name,
  };
}

export function SkillsView({
  activeSkillId,
  onActiveSkillIdChange,
  onBreadcrumbLabelChange,
  onStartChatWithSkill,
}: SkillsViewProps) {
  const { t } = useTranslation(["skills", "common"]);
  const reduceMotion = useReducedMotion();
  const projects = useProjectStore(selectProjects);
  const isActiveSkillControlled = activeSkillId !== undefined;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<EditingSkill | undefined>(
    undefined,
  );
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingSkill, setDeletingSkill] = useState<SkillInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchCloseVisible, setSearchCloseVisible] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSearchFocusRef = useRef(false);
  const [skillScope, setSkillScope] = useState<SkillScope>("all");
  const [internalActiveSkillId, setInternalActiveSkillId] = useState<
    string | null
  >(null);
  const loadRequestIdRef = useRef(0);
  const currentActiveSkillId = isActiveSkillControlled
    ? activeSkillId
    : internalActiveSkillId;
  const setActiveSkill = useCallback(
    (skillId: string | null, options?: AppNavigationUpdateOptions) => {
      if (!isActiveSkillControlled) {
        setInternalActiveSkillId(skillId);
      }
      onActiveSkillIdChange?.(skillId, options);
    },
    [isActiveSkillControlled, onActiveSkillIdChange],
  );

  const loadSkills = useCallback(async (): Promise<SkillInfo[]> => {
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    setLoading(true);

    try {
      const projectDirs = projects.flatMap((project) => project.workingDirs);
      const result = await listSkills(projectDirs);
      if (loadRequestIdRef.current !== requestId) {
        return [];
      }
      const nextSkills = hydrateProjectNames(result, projects);
      setSkills(nextSkills);
      return nextSkills;
    } catch (error) {
      if (loadRequestIdRef.current === requestId) {
        setSkills([]);
        toast.error(formatAcpErrorMessage(error, t("view.loadError")));
      }
      return [];
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [projects, t]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    return listenSkillsChanged(() => {
      void loadSkills();
    });
  }, [loadSkills]);

  const projectsWithSkillDirs = useMemo(
    () => projects.filter((project) => project.workingDirs.length > 0),
    [projects],
  );

  useEffect(() => {
    if (!skillScope.startsWith("project:")) {
      return;
    }
    const selectedProjectId = skillScope.replace(/^project:/, "");
    if (
      !projectsWithSkillDirs.some((project) => project.id === selectedProjectId)
    ) {
      setSkillScope("all");
    }
  }, [projectsWithSkillDirs, skillScope]);

  const activeSkill =
    skills.find((skill) => skill.id === currentActiveSkillId) ?? null;

  useEffect(() => {
    onBreadcrumbLabelChange?.(activeSkill?.name ?? null);
  }, [activeSkill?.name, onBreadcrumbLabelChange]);

  useEffect(() => {
    return () => onBreadcrumbLabelChange?.(null);
  }, [onBreadcrumbLabelChange]);

  const visibleSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skillMatchesScope(skill, skillScope) &&
          skillMatchesQuery(skill, searchQuery),
      ),
    [searchQuery, skillScope, skills],
  );

  const selectedProjectId = skillScope.startsWith("project:")
    ? skillScope.replace(/^project:/, "")
    : null;
  const resolveSkillForSelectedScope = useCallback(
    (skill: SkillInfo) => resolveSkillForProjectScope(skill, selectedProjectId),
    [selectedProjectId],
  );

  const selectedScopeLabel = useMemo(() => {
    if (selectedProjectId) {
      return (
        projects.find((project) => project.id === selectedProjectId)?.name ??
        t("view.scope.project")
      );
    }
    return skillScope === "all"
      ? t("view.scope.all")
      : t("view.scope.personal");
  }, [projects, selectedProjectId, skillScope, t]);

  useEffect(() => {
    if (currentActiveSkillId && !loading && !activeSkill) {
      setActiveSkill(null, { replace: true });
    }
  }, [activeSkill, currentActiveSkillId, loading, setActiveSkill]);

  const handleDelete = (skill: SkillInfo) => {
    const scopedSkill = resolveSkillForSelectedScope(skill);
    if (scopedSkill.readonly) {
      return;
    }
    setDeletingSkill(scopedSkill);
  };

  const handleConfirmDeleteSkill = async () => {
    const skillToDelete = deletingSkill;
    if (!skillToDelete) return;
    if (skillToDelete.readonly) {
      setDeletingSkill(null);
      return;
    }
    try {
      await deleteSkill(skillToDelete.path);
      setSkills((current) =>
        current.flatMap((skill) => {
          if (
            skill.sourceKind === "project" &&
            skill.id === skillToDelete.id &&
            skill.projectLinks.length > 1
          ) {
            const projectLinks = skill.projectLinks.filter(
              (project) => project.path !== skillToDelete.path,
            );
            if (projectLinks.length === skill.projectLinks.length) {
              return [skill];
            }
            if (projectLinks.length === 0) {
              return [];
            }

            return [
              {
                ...skill,
                path: projectLinks[0].path,
                fileLocation: projectLinks[0].fileLocation,
                sourceLabel: projectLinks[0].name,
                projectLinks,
              },
            ];
          }

          return skill.id !== skillToDelete.id &&
            skill.path !== skillToDelete.path
            ? [skill]
            : [];
        }),
      );
      if (currentActiveSkillId === skillToDelete.id) {
        setActiveSkill(null, { replace: true });
      }
      toast.success(t("view.deleteSuccess", { name: skillToDelete.name }));
    } catch (error) {
      toast.error(formatAcpErrorMessage(error, t("view.deleteError")));
    }
    setDeletingSkill(null);
  };

  const handleEdit = (skill: SkillInfo) => {
    const scopedSkill = resolveSkillForSelectedScope(skill);
    if (scopedSkill.readonly) {
      return;
    }
    setEditingSkill({
      name: scopedSkill.name,
      description: scopedSkill.description,
      instructions: scopedSkill.instructions,
      path: scopedSkill.path,
      fileLocation: scopedSkill.fileLocation,
      color: scopedSkill.color,
    });
    setDialogOpen(true);
  };

  const handleReveal = useCallback(
    (skill: SkillInfo) => {
      const scopedSkill = resolveSkillForSelectedScope(skill);
      if (scopedSkill.readonly) {
        return;
      }
      void revealInFileManager(scopedSkill.path);
    },
    [resolveSkillForSelectedScope],
  );

  const handleStartChat = useCallback(
    (skill: SkillInfo) => {
      const scopedSkill = resolveSkillForSelectedScope(skill);
      const projectId =
        getProjectLinkForScope(scopedSkill, selectedProjectId)?.id ?? null;
      onStartChatWithSkill?.(scopedSkill, projectId);
    },
    [onStartChatWithSkill, resolveSkillForSelectedScope, selectedProjectId],
  );

  const handleDialogClose = () => {
    setDialogOpen(false);
    setEditingSkill(undefined);
  };

  // Wire Delete from inside the SkillEditor footer: close the editor sheet,
  // then surface the existing AlertDialog delete confirmation.
  const handleDeleteFromEditor = useCallback(
    (editing: EditingSkill) => {
      const match = skills.find(
        (skill) =>
          skill.path === editing.path ||
          skill.projectLinks.some((project) => project.path === editing.path),
      );
      setDialogOpen(false);
      setEditingSkill(undefined);
      if (match) {
        setDeletingSkill(resolveSkillForPath(match, editing.path));
      }
    },
    [skills],
  );

  const handleNewSkill = useCallback(() => {
    setEditingSkill(undefined);
    setDialogOpen(true);
  }, []);

  const handleSkillSaved = useCallback(
    (savedSkill?: SkillInfo) => {
      if (!savedSkill) {
        return;
      }

      const previousPath = editingSkill?.path;
      setSkills((current) => {
        const existingIndex = current.findIndex(
          (skill) =>
            skill.id === savedSkill.id ||
            skill.path === savedSkill.path ||
            skill.projectLinks.some(
              (project) => project.path === savedSkill.path,
            ) ||
            (previousPath ? skill.path === previousPath : false),
        );
        if (existingIndex === -1) {
          return [...current, savedSkill];
        }

        const next = [...current];
        next[existingIndex] = savedSkill;
        return next;
      });
      setActiveSkill(savedSkill.id);
    },
    [editingSkill?.path, setActiveSkill],
  );

  const { fileInputRef, handleFileChange, openFilePicker, handleExport } =
    useSkillImportExport();

  useEffect(() => {
    if (!searchOpen) {
      setSearchCloseVisible(false);
      if (restoreSearchFocusRef.current) {
        restoreSearchFocusRef.current = false;
        window.requestAnimationFrame(() => searchTriggerRef.current?.focus());
      }
      return;
    }
    searchInputRef.current?.focus();
    if (reduceMotion) {
      setSearchCloseVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setSearchCloseVisible(true), 180);
    return () => window.clearTimeout(timer);
  }, [reduceMotion, searchOpen]);

  const closeSearch = useCallback(() => {
    restoreSearchFocusRef.current = true;
    setSearchQuery("");
    setSearchOpen(false);
  }, []);

  const handleShare = useCallback(
    (skill: SkillInfo) => {
      const scopedSkill = resolveSkillForSelectedScope(skill);
      if (scopedSkill.readonly) {
        return;
      }
      void handleExport(scopedSkill);
    },
    [handleExport, resolveSkillForSelectedScope],
  );

  const handleSelectSkill = (skill: SkillInfo) => {
    setActiveSkill(skill.id);
  };

  const dialogs = (
    <SkillsDialogs
      dialogOpen={dialogOpen}
      onDialogClose={handleDialogClose}
      onSaved={handleSkillSaved}
      editingSkill={editingSkill}
      initialProjectId={selectedProjectId}
      deletingSkill={deletingSkill}
      onDeletingSkillChange={setDeletingSkill}
      onConfirmDelete={handleConfirmDeleteSkill}
      onDeleteFromEditor={handleDeleteFromEditor}
    />
  );

  if (activeSkill) {
    const scopedActiveSkill = resolveSkillForSelectedScope(activeSkill);
    return (
      <>
        <SkillDetailPage
          skill={scopedActiveSkill}
          onEdit={handleEdit}
          onReveal={handleReveal}
          onShare={handleShare}
          onStartChat={onStartChatWithSkill ? handleStartChat : undefined}
          onDelete={handleDelete}
        />
        {dialogs}
      </>
    );
  }

  return (
    <PageShell contentWidth="full">
      <section
        aria-labelledby="skills-heading"
        className="mx-auto flex w-full max-w-[70rem] flex-col gap-10"
      >
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <PageToolbarButton
                  type="button"
                  size="xs"
                  className="max-w-44 text-sm"
                  aria-label={t("view.scope.ariaLabel")}
                  rightIcon={<IconChevronDown />}
                >
                  <span className="min-w-0 truncate">{selectedScopeLabel}</span>
                </PageToolbarButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={skillScope}
                  onValueChange={(value) => setSkillScope(value as SkillScope)}
                >
                  <DropdownMenuRadioItem value="all" indicatorSide="end">
                    {t("view.scope.all")}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="global" indicatorSide="end">
                    {t("view.scope.personal")}
                  </DropdownMenuRadioItem>
                  {projectsWithSkillDirs.length > 0 ? (
                    <DropdownMenuLabel className="pt-4 text-sm text-muted-foreground/60">
                      {t("view.scope.projects")}
                    </DropdownMenuLabel>
                  ) : null}
                  {projectsWithSkillDirs.map((project) => (
                    <DropdownMenuRadioItem
                      key={project.id}
                      value={`project:${project.id}`}
                      indicatorSide="end"
                    >
                      {project.name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <AnimatePresence initial={false} mode="popLayout">
              {searchOpen || searchQuery ? (
                <motion.div
                  key="search-field"
                  initial={{ width: 32, opacity: 0 }}
                  animate={{
                    width: "min(256px, calc(100vw - 96px))",
                    opacity: 1,
                  }}
                  exit={{ width: 32, opacity: 0 }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { type: "spring", stiffness: 420, damping: 38 }
                  }
                  data-search-field-container
                  data-search-motion={reduceMotion ? "reduced" : "full"}
                  className="relative overflow-hidden rounded-full"
                >
                  <SearchBar
                    size="pill-card"
                    value={searchQuery}
                    onChange={setSearchQuery}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        closeSearch();
                      }
                    }}
                    placeholder={t("view.searchPlaceholder")}
                    aria-label={t("view.searchAriaLabel")}
                    inputRef={searchInputRef}
                    className="w-64 pr-9"
                  />
                  {searchCloseVisible ? (
                    <div className="absolute right-1 top-1/2 -translate-y-1/2">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t("common:actions.close")}
                        title={t("common:actions.close")}
                        onClick={closeSearch}
                      >
                        <svg
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          className="!size-4"
                        >
                          <path
                            d="M3.5 3.5l9 9m0-9l-9 9"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                          />
                        </svg>
                      </Button>
                    </div>
                  ) : null}
                </motion.div>
              ) : (
                <motion.div
                  key="search-action"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={reduceMotion ? { duration: 0 } : undefined}
                >
                  <PageToolbarButton
                    ref={searchTriggerRef}
                    type="button"
                    size="icon-xs"
                    aria-label={t("view.searchAriaLabel")}
                    title={t("view.searchAriaLabel")}
                    onClick={() => setSearchOpen(true)}
                  >
                    <IconSearch className="!size-4" />
                  </PageToolbarButton>
                </motion.div>
              )}
            </AnimatePresence>
            <PageToolbarButton
              type="button"
              size="icon-xs"
              aria-label={t("common:actions.import")}
              tooltip={t("common:actions.import")}
              onClick={openFilePicker}
            >
              <IconArrowDownToArc className="!size-4" />
            </PageToolbarButton>
            <PageToolbarButton
              type="button"
              size="icon-xs"
              aria-label={t("view.newSkill")}
              tooltip={t("view.newSkill")}
              onClick={handleNewSkill}
            >
              <IconPlus className="!size-4" />
            </PageToolbarButton>
          </div>
        </div>
        <SkillsGrid
          skills={visibleSkills}
          isLoading={loading}
          onSelectSkill={handleSelectSkill}
          onCreateSkill={handleNewSkill}
          onEditSkill={handleEdit}
          onDeleteSkill={handleDelete}
        />
      </section>

      <input
        ref={fileInputRef}
        type="file"
        accept=".skill.json,.json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />

      {dialogs}
    </PageShell>
  );
}
