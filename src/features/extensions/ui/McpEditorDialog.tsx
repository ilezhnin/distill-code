import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { McpHarnessId } from "../api/localMcpInventory";
import {
  configurationFromDraft,
  normalizeMcpConfiguration,
  parseArguments,
  parseStringMap,
} from "../lib/mcpManager";
import { Alert, AlertDescription } from "@/shared/ui/alert";
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
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/ui/select";
import { Textarea } from "@/shared/ui/textarea";

export function McpEditorDialog({
  initial,
  name,
  harness,
  onClose,
  onSave,
}: {
  initial?: Record<string, unknown>;
  name?: string;
  harness?: McpHarnessId;
  onClose: () => void;
  onSave: (configuration: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const normalized = normalizeMcpConfiguration(initial ?? {});
  const [displayName, setDisplayName] = useState(
    name ?? String(normalized.name),
  );
  const [description, setDescription] = useState(
    String(normalized.description),
  );
  const [transport, setTransport] = useState<"stdio" | "http">(
    normalized.transport === "stdio" ? "stdio" : "http",
  );
  const [command, setCommand] = useState(String(normalized.command));
  const [args, setArgs] = useState(JSON.stringify(normalized.args, null, 2));
  const [url, setUrl] = useState(String(normalized.url));
  const [env, setEnv] = useState(JSON.stringify(normalized.env, null, 2));
  const [headers, setHeaders] = useState(
    JSON.stringify(normalized.headers, null, 2),
  );
  const [advanced, setAdvanced] = useState(false);
  const [importText, setImportText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const importConfiguration = () => {
    try {
      const parsed: unknown = JSON.parse(importText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid");
      const object = parsed as Record<string, unknown>;
      const serverMap = object.mcpServers ?? object.mcp_servers ?? object.mcp;
      const entries =
        serverMap && typeof serverMap === "object" && !Array.isArray(serverMap)
          ? Object.entries(serverMap)
          : [];
      if (entries.length > 1) {
        setError(t("mcpManager.singleImport"));
        return;
      }
      const [importName, value] = entries[0] ?? [object.name ?? "", object];
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("invalid");
      const normalized = normalizeMcpConfiguration(
        value as Record<string, unknown>,
      );
      setDisplayName(String(importName || normalized.name));
      setDescription(String(normalized.description));
      setTransport(normalized.transport === "stdio" ? "stdio" : "http");
      setCommand(String(normalized.command));
      setArgs(JSON.stringify(normalized.args, null, 2));
      setUrl(String(normalized.url));
      setEnv(JSON.stringify(normalized.env, null, 2));
      setHeaders(JSON.stringify(normalized.headers, null, 2));
      setImportText("");
      setError(null);
    } catch {
      setError(t("mcpManager.invalidImport"));
    }
  };

  const save = async () => {
    setError(null);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(displayName)) {
      setError(t("mcpManager.invalidName"));
      return;
    }
    if (transport === "stdio" && !command.trim()) {
      setError(t("mcpManager.commandRequired"));
      return;
    }
    if (transport === "http") {
      try {
        if (!["http:", "https:"].includes(new URL(url).protocol))
          throw new Error("invalid");
      } catch {
        setError(t("mcpManager.invalidUrl"));
        return;
      }
    }
    let configuration: Record<string, unknown>;
    try {
      configuration = configurationFromDraft(
        {
          name: displayName.trim(),
          description,
          transport,
          command: command.trim(),
          args: parseArguments(args),
          url: url.trim(),
          env: parseStringMap(env),
          headers: parseStringMap(headers),
        },
        initial ?? {},
        harness,
      );
    } catch (error) {
      setError(
        t(
          error instanceof Error && error.message === "invalidArgs"
            ? "mcpManager.invalidArgs"
            : "mcpManager.invalidMap",
        ),
      );
      return;
    }
    setSaving(true);
    try {
      await onSave(configuration);
      onClose();
    } catch (error) {
      setError(String(error instanceof Error ? error.message : error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            {t(initial ? "mcpManager.configureTitle" : "mcpManager.addTitle")}
          </DialogTitle>
          <DialogDescription>
            {t(
              harness
                ? "mcpManager.nativeEditDescription"
                : "mcpManager.addDescription",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="mcp-name">{t("mcpManager.name")}</Label>
              <Input
                id="mcp-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                disabled={Boolean(initial)}
                placeholder={t("mcpManager.namePlaceholder")}
                autoComplete="off"
                maxLength={128}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-description">
                {t("mcpManager.description")}
              </Label>
              <Input
                id="mcp-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={2048}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-transport">{t("mcpManager.transport")}</Label>
              <Select
                value={transport}
                onValueChange={(value) =>
                  setTransport(value as "stdio" | "http")
                }
              >
                <SelectTrigger id="mcp-transport">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">{t("mcpManager.remote")}</SelectItem>
                  <SelectItem value="stdio">{t("mcpManager.local")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {transport === "http" ? (
              <div className="space-y-2">
                <Label htmlFor="mcp-url">{t("mcpManager.endpoint")}</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t("mcpManager.urlPlaceholder")}
                  autoComplete="off"
                />
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label htmlFor="mcp-command">{t("mcpManager.command")}</Label>
                  <Input
                    id="mcp-command"
                    value={command}
                    onChange={(event) => setCommand(event.target.value)}
                    placeholder={t("mcpManager.commandPlaceholder")}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-args">{t("mcpManager.arguments")}</Label>
                  <Textarea
                    id="mcp-args"
                    value={args}
                    onChange={(event) => setArgs(event.target.value)}
                    className="font-mono text-xs"
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              flush
              onClick={() => setAdvanced(!advanced)}
            >
              {t(advanced ? "mcpManager.hideAdvanced" : "mcpManager.advanced")}
            </Button>
            {advanced ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="mcp-env">{t("mcpManager.environment")}</Label>
                  <Textarea
                    id="mcp-env"
                    value={env}
                    onChange={(event) => setEnv(event.target.value)}
                    className="font-mono text-xs"
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="mcp-headers">{t("mcpManager.headers")}</Label>
                  <Textarea
                    id="mcp-headers"
                    value={headers}
                    onChange={(event) => setHeaders(event.target.value)}
                    className="font-mono text-xs"
                    rows={3}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                {!initial ? (
                  <div className="space-y-2">
                    <Label htmlFor="mcp-import">
                      {t("mcpManager.pasteConfiguration")}
                    </Label>
                    <Textarea
                      id="mcp-import"
                      value={importText}
                      onChange={(event) => setImportText(event.target.value)}
                      rows={3}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={importConfiguration}
                      disabled={!importText.trim()}
                    >
                      {t("mcpManager.importConfiguration")}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={saving}
          >
            {t("mcpManager.cancel")}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void save()}
            feedbackState={saving ? "loading" : "idle"}
            loadingLabel={t("mcpManager.saving")}
          >
            {t(initial ? "mcpManager.save" : "mcpManager.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
