import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Globe,
  Plug,
  Plus,
  RefreshCw,
  Settings2,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  listExtensions,
  removeExtension,
  saveExtension,
  setExtensionEnabled,
} from "../api/extensions";
import {
  listLocalMcpInventory,
  LOCAL_MCP_INVENTORY_QUERY_KEY,
  type McpConfiguredServer,
} from "../api/localMcpInventory";
import {
  checkMcpConnection,
  listMcpDiagnostics,
  MANAGED_MCP_QUERY_KEY,
  MCP_DIAGNOSTICS_QUERY_KEY,
  readLocalMcpConfiguration,
  updateLocalMcpConfiguration,
  type LocalMcpConfiguration,
} from "../api/mcpManager";
import { HARNESS_LABELS, harnessesWithErrors } from "../lib/localMcpInventory";
import {
  itemEnabled,
  itemHarnesses,
  latestItemDiagnostic,
  mcpItems,
  searchMcpItems,
  type McpItem,
} from "../lib/mcpManager";
import type { ExtensionConfig } from "../types";
import { Alert, AlertDescription, AlertTitle } from "@/shared/ui/alert";
import { Button } from "@/shared/ui/button";
import { Card, CardContent } from "@/shared/ui/card";
import { ConfirmDialog } from "@/shared/ui/confirm-dialog";
import { PageHeader } from "@/shared/ui/page-shell";
import { SearchBar } from "@/shared/ui/SearchBar";
import {
  SettingsSection,
  SettingsSections,
} from "@/shared/ui/settings-section";
import { SettingsRow } from "@/shared/ui/settings-row";
import { Skeleton } from "@/shared/ui/skeleton";
import { Switch } from "@/shared/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/shared/ui/tabs";
import { ConnectionCard } from "./ConnectionCard";
import { McpEditorDialog } from "./McpEditorDialog";
import { McpStatusBadge } from "./McpStatusBadge";

interface McpTarget {
  item: McpItem;
  source?: McpConfiguredServer;
}

interface EditorState extends McpTarget {
  configuration: Record<string, unknown>;
  local?: LocalMcpConfiguration;
}

export function McpManager({ workspacePaths }: { workspacePaths: string[] }) {
  const { t } = useTranslation("settings");
  const queryClient = useQueryClient();
  const inventoryQuery = useQuery({
    queryKey: [...LOCAL_MCP_INVENTORY_QUERY_KEY, workspacePaths],
    queryFn: () => listLocalMcpInventory(workspacePaths),
    staleTime: 10_000,
  });
  const managedQuery = useQuery({
    queryKey: MANAGED_MCP_QUERY_KEY,
    queryFn: listExtensions,
  });
  const diagnosticsQuery = useQuery({
    queryKey: MCP_DIAGNOSTICS_QUERY_KEY,
    queryFn: listMcpDiagnostics,
    retry: false,
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("installed");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [removing, setRemoving] = useState<McpTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const items = mcpItems(inventoryQuery.data, managedQuery.data ?? []);
  const diagnostics = diagnosticsQuery.data ?? {};
  const selected = items.find(
    (item) =>
      item.id === selectedId ||
      item.sources.some((source) => source.id === selectedId),
  );
  const issues = items.filter((item) => {
    const status = latestItemDiagnostic(item, diagnostics)?.status;
    return itemEnabled(item) && (status === "error" || status === "needsAuth");
  });
  const visibleItems = searchMcpItems(
    filter === "issues" ? issues : items,
    search,
  );
  const failedSources = harnessesWithErrors(inventoryQuery.data);
  const loading = inventoryQuery.isLoading || managedQuery.isLoading;
  const queryError =
    inventoryQuery.error ?? managedQuery.error ?? diagnosticsQuery.error;
  const restartRequired = /Command list_mcp_diagnostics not found/i.test(
    String(diagnosticsQuery.error),
  );

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: LOCAL_MCP_INVENTORY_QUERY_KEY,
      }),
      queryClient.invalidateQueries({ queryKey: MANAGED_MCP_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: MCP_DIAGNOSTICS_QUERY_KEY }),
    ]);
  };

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const toggle = (target: McpTarget, enabled: boolean) =>
    run(`toggle:${target.source?.id ?? target.item.id}`, async () => {
      if (target.source) {
        const configuration = await readLocalMcpConfiguration(
          target.source.id,
          workspacePaths,
        );
        await updateLocalMcpConfiguration(
          target.source.id,
          configuration.revision,
          workspacePaths,
          { enabled },
        );
      } else if (target.item.managed) {
        await setExtensionEnabled(target.item.managed.config_key, enabled);
      }
    });

  const edit = (target: McpTarget) =>
    run(`edit:${target.source?.id ?? target.item.id}`, async () => {
      if (target.source) {
        const local = await readLocalMcpConfiguration(
          target.source.id,
          workspacePaths,
        );
        setEditor({ ...target, configuration: local.configuration, local });
      } else if (target.item.managed) {
        const {
          config_key: _key,
          enabled: _enabled,
          configurationRevision: _revision,
          ...configuration
        } = target.item.managed;
        setEditor({ ...target, configuration });
      }
    });

  const check = (target: McpTarget) =>
    run(`check:${target.source?.id ?? target.item.id}`, async () => {
      const id = target.source?.id ?? target.item.id;
      const managed = target.item.managed;
      const raw = managed
        ? Object.fromEntries(
            Object.entries(managed).filter(
              ([key]) =>
                !["config_key", "enabled", "configurationRevision"].includes(
                  key,
                ),
            ),
          )
        : undefined;
      await checkMcpConnection(
        id,
        workspacePaths,
        target.source ? undefined : raw,
      );
    });

  const remove = async () => {
    if (!removing) return;
    await run(`remove:${removing.source?.id ?? removing.item.id}`, async () => {
      if (removing.source) {
        const current = await readLocalMcpConfiguration(
          removing.source.id,
          workspacePaths,
        );
        await updateLocalMcpConfiguration(
          removing.source.id,
          current.revision,
          workspacePaths,
          { remove: true, confirmed: true },
        );
      } else if (removing.item.managed) {
        await removeExtension(removing.item.managed.config_key);
      }
      setRemoving(null);
    });
  };

  const targetActions = (target: McpTarget, enabled: boolean) => {
    const id = target.source?.id ?? target.item.id;
    const providedByPlugin = target.source?.source.scope === "plugin";
    return (
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void check(target)}
          disabled={Boolean(busy) || restartRequired}
          feedbackState={busy === `check:${id}` ? "loading" : "idle"}
          loadingLabel={t("mcpManager.checking")}
        >
          {t("mcpManager.check")}
        </Button>
        {!providedByPlugin ? (
          <>
            {!id.startsWith("grok-inherited:") ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  leftIcon={<Settings2 />}
                  onClick={() => void edit(target)}
                  disabled={Boolean(busy) || restartRequired}
                  aria-label={t("mcpManager.configureNamed", {
                    name: target.item.name,
                  })}
                  title={t("mcpManager.configure")}
                />
                <Button
                  type="button"
                  variant="ghost"
                  destructive
                  size="icon-xs"
                  leftIcon={<Trash2 />}
                  onClick={() => setRemoving(target)}
                  disabled={Boolean(busy) || restartRequired}
                  aria-label={t("mcpManager.removeNamed", {
                    name: target.item.name,
                  })}
                  title={t("mcpManager.remove")}
                />
              </>
            ) : null}
            <Switch
              checked={enabled}
              onCheckedChange={(enabled) => void toggle(target, enabled)}
              disabled={Boolean(busy) || restartRequired}
              aria-label={t("mcpManager.enableNamed", {
                name: target.item.name,
                provider: target.source
                  ? HARNESS_LABELS[target.source.harness]
                  : "Distill",
              })}
            />
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      {selected ? (
        <>
          <div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              flush
              leftIcon={<ArrowLeft />}
              onClick={() => setSelectedId(null)}
            >
              {t("mcpManager.back")}
            </Button>
          </div>
          <PageHeader
            title={selected.name}
            description={
              selected.description ||
              t("connections.worksWith", { harnesses: itemHarnesses(selected) })
            }
            variant="detail"
            actions={
              <McpStatusBadge
                enabled={itemEnabled(selected)}
                diagnostic={latestItemDiagnostic(selected, diagnostics)}
              />
            }
          />
          <p className="text-xs text-muted-foreground">
            {t("mcpManager.changesApply")}
          </p>
          <SettingsSections>
            <SettingsSection title={t("mcpManager.configurations")}>
              {selected.managed ? (
                <Card className="gap-0 py-0">
                  <CardContent className="px-5">
                    <SettingsRow
                      label="Distill"
                      description={t("mcpManager.managedSource")}
                      details={selected.endpoint ?? selected.transport}
                      action={targetActions(
                        { item: selected },
                        selected.managed.enabled,
                      )}
                    />
                  </CardContent>
                </Card>
              ) : (
                selected.sources.map((source) => (
                  <Card key={source.id} className="gap-0 py-0">
                    <CardContent className="px-5">
                      <SettingsRow
                        label={HARNESS_LABELS[source.harness]}
                        description={
                          source.source.scope === "plugin"
                            ? t("mcpManager.pluginSource", {
                                source: source.source.label,
                              })
                            : source.id.startsWith("grok-inherited:")
                              ? t("mcpManager.inheritedSource", {
                                  source: source.source.label,
                                })
                              : source.source.label
                        }
                        details={source.endpoint ?? source.transport}
                        action={targetActions(
                          { item: selected, source },
                          source.enabled !== false,
                        )}
                      />
                    </CardContent>
                  </Card>
                ))
              )}
            </SettingsSection>
            <SettingsSection title={t("mcpManager.connectionDetails")}>
              {(selected.managed
                ? [
                    {
                      id: selected.id,
                      provider: "Distill",
                      result: latestItemDiagnostic(selected, diagnostics),
                    },
                  ]
                : selected.sources.map((source) => ({
                    id: source.id,
                    provider: HARNESS_LABELS[source.harness],
                    result:
                      source.configurationRevision ===
                      diagnostics[source.id]?.configurationRevision
                        ? diagnostics[source.id]
                        : undefined,
                  }))
              ).map(({ id, provider, result }) => (
                <Card key={id}>
                  <CardContent className="space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-sm font-medium">{provider}</span>
                      <McpStatusBadge
                        enabled={
                          selected.managed?.enabled ??
                          selected.sources.find((source) => source.id === id)
                            ?.enabled !== false
                        }
                        diagnostic={result}
                      />
                    </div>
                    {!result ? (
                      <p className="text-sm text-muted-foreground">
                        {t("mcpManager.notCheckedDescription")}
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          {t("mcpManager.checkedAt", {
                            date: new Date(result.checkedAt).toLocaleString(),
                          })}
                        </p>
                        {result.serverName || result.serverVersion ? (
                          <p className="text-sm">
                            {[result.serverName, result.serverVersion]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        ) : null}
                        {result.message ? (
                          <Alert variant="destructive">
                            <AlertTitle>
                              {t(
                                result.status === "needsAuth"
                                  ? "mcpManager.authRequired"
                                  : "mcpManager.connectionFailed",
                              )}
                            </AlertTitle>
                            <AlertDescription>
                              <p className="break-words">{result.message}</p>
                              {result.status === "needsAuth" ? (
                                <p>{t("mcpManager.authHelp")}</p>
                              ) : null}
                            </AlertDescription>
                          </Alert>
                        ) : null}
                        {result.status === "connected" ? (
                          <>
                            <h3 className="text-sm font-medium">
                              {t("mcpManager.tools", {
                                count: result.tools.length,
                              })}
                            </h3>
                            {result.tools.length === 0 ? (
                              <p className="text-xs text-muted-foreground">
                                {t("mcpManager.noTools")}
                              </p>
                            ) : (
                              <div className="space-y-3">
                                {result.tools.map((tool) => (
                                  <div key={tool.name}>
                                    <p className="text-sm font-medium">
                                      {tool.name}
                                    </p>
                                    {tool.description ? (
                                      <p className="text-xs text-muted-foreground">
                                        {tool.description}
                                      </p>
                                    ) : null}
                                  </div>
                                ))}
                              </div>
                            )}
                          </>
                        ) : null}
                      </>
                    )}
                  </CardContent>
                </Card>
              ))}
            </SettingsSection>
          </SettingsSections>
        </>
      ) : (
        <>
          <PageHeader
            title={t("mcpManager.title")}
            description={t("mcpManager.descriptionText")}
            variant="default"
            actions={
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void refresh()}
                  leftIcon={<RefreshCw />}
                  disabled={Boolean(busy)}
                >
                  {t("mcpManager.refresh")}
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => setAdding(true)}
                  leftIcon={<Plus />}
                >
                  {t("mcpManager.add")}
                </Button>
              </div>
            }
          />
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Tabs value={filter} onValueChange={setFilter}>
              <TabsList>
                <TabsTrigger value="installed">
                  {t("mcpManager.installed", { count: items.length })}
                </TabsTrigger>
                <TabsTrigger value="issues">
                  {t("mcpManager.issues", {
                    count: issues.length + failedSources.length,
                  })}
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="w-full sm:w-72">
              <SearchBar
                value={search}
                onChange={setSearch}
                placeholder={t("mcpManager.search")}
                aria-label={t("mcpManager.search")}
              />
            </div>
          </div>
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((key) => (
                <Skeleton key={key} className="h-20 w-full rounded-lg" />
              ))}
            </div>
          ) : visibleItems.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-start gap-3">
                <Plug className="size-6 text-muted-foreground" />
                <p className="text-sm">
                  {t(
                    search.trim()
                      ? "connections.noResults"
                      : filter === "issues"
                        ? "mcpManager.noIssues"
                        : "connections.empty.title",
                  )}
                </p>
                {filter === "installed" && !search.trim() ? (
                  <p className="text-xs text-muted-foreground">
                    {t("mcpManager.emptyDescription")}
                  </p>
                ) : null}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {visibleItems.map((item) => (
                <Card key={item.id} className="gap-0 py-0">
                  <CardContent className="px-5">
                    <ConnectionCard
                      name={item.name}
                      icon={
                        item.transport === "stdio" ? <Terminal /> : <Globe />
                      }
                      description={
                        <div className="space-y-1">
                          {item.description ? <p>{item.description}</p> : null}
                          <p>
                            {t("connections.worksWith", {
                              harnesses: itemHarnesses(item),
                            })}
                          </p>
                        </div>
                      }
                      badge={
                        <McpStatusBadge
                          enabled={itemEnabled(item)}
                          diagnostic={latestItemDiagnostic(item, diagnostics)}
                        />
                      }
                      action={
                        <div className="grid grid-cols-[auto_2rem] items-center gap-3">
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                              setSelectedId(item.sources[0]?.id ?? item.id)
                            }
                          >
                            {t("mcpManager.details")}
                          </Button>
                          {item.managed ||
                          (item.sources.length === 1 &&
                            item.sources[0].source.scope !== "plugin") ? (
                            <Switch
                              checked={itemEnabled(item)}
                              disabled={Boolean(busy) || restartRequired}
                              onCheckedChange={(enabled) =>
                                void toggle(
                                  { item, source: item.sources[0] },
                                  enabled,
                                )
                              }
                              aria-label={t("mcpManager.enableNamed", {
                                name: item.name,
                                provider: itemHarnesses(item),
                              })}
                            />
                          ) : (
                            <span aria-hidden="true" />
                          )}
                        </div>
                      }
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {failedSources.length > 0 ? (
        <Alert>
          <AlertTitle>{t("connections.localError.partialTitle")}</AlertTitle>
          <AlertDescription>
            {failedSources.map((source) => (
              <p key={source.harness}>
                {HARNESS_LABELS[source.harness]}:{" "}
                {source.message ??
                  t("connections.localError.partialDescription")}
              </p>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      {error || queryError ? (
        <Alert variant="destructive">
          <AlertTitle>
            {t(
              restartRequired
                ? "mcpManager.restartTitle"
                : "mcpManager.actionFailed",
            )}
          </AlertTitle>
          <AlertDescription>
            {restartRequired
              ? t("mcpManager.restartDescription")
              : (error ??
                String(
                  queryError instanceof Error ? queryError.message : queryError,
                ))}
            <Button
              type="button"
              variant="alert"
              size="xs"
              onClick={() => {
                setError(null);
                void refresh();
              }}
            >
              {t("connections.localError.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {adding ? (
        <McpEditorDialog
          onClose={() => setAdding(false)}
          onSave={async (configuration) => {
            const normalized = String(configuration.name)
              .toLowerCase()
              .replace(/[^a-z0-9]/g, "_");
            if (
              (managedQuery.data ?? []).some(
                (entry) => entry.config_key === normalized,
              )
            )
              throw new Error(t("mcpManager.duplicateName"));
            await saveExtension(configuration as unknown as ExtensionConfig);
            await refresh();
          }}
        />
      ) : null}
      {editor ? (
        <McpEditorDialog
          key={editor.source?.id ?? editor.item.id}
          initial={editor.configuration}
          name={editor.item.name}
          harness={
            editor.source?.harness === "grok" &&
            editor.source.id.startsWith("grok-inherited:")
              ? "claudeCode"
              : editor.source?.harness
          }
          onClose={() => setEditor(null)}
          onSave={async (configuration) => {
            if (editor.source && editor.local)
              await updateLocalMcpConfiguration(
                editor.source.id,
                editor.local.revision,
                workspacePaths,
                { configuration },
              );
            else
              await saveExtension(
                configuration as unknown as ExtensionConfig,
                editor.item.managed?.enabled,
              );
            await refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t("mcpManager.removeTitle", { name: removing?.item.name ?? "" })}
        description={t(
          removing?.source
            ? "mcpManager.removeNativeDescription"
            : "mcpManager.removeDescription",
          {
            provider: removing?.source
              ? HARNESS_LABELS[removing.source.harness]
              : "Distill",
            source: removing?.source?.source.label ?? "",
          },
        )}
        cancelLabel={t("mcpManager.cancel")}
        confirmLabel={t("mcpManager.remove")}
        loadingLabel={t("mcpManager.removing")}
        isLoading={Boolean(busy?.startsWith("remove:"))}
        onConfirm={remove}
      />
    </div>
  );
}
