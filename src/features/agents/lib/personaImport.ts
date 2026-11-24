import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { normalizeAgentRef, personaAgentRefs } from "@/shared/lib/agentSpawns";
import {
  isJsonImportFileName,
  isPersonaMarkdownImportFileName,
} from "@/shared/lib/personaImportFileName";

const JSON_MIME_TYPES = new Set([
  "",
  "application/json",
  "application/x-json",
  "text/json",
  "text/plain",
]);
const MARKDOWN_MIME_TYPES = new Set([
  "",
  "text/markdown",
  "text/plain",
  "application/octet-stream",
]);

export const MAX_PERSONA_IMPORT_BYTES = 4 * 1024 * 1024;

export interface ImportMessageDescriptor {
  key:
    | "view.importInvalidExtension"
    | "view.importInvalidMimeType"
    | "view.importTooLarge"
    | "view.imported_one"
    | "view.imported_other";
  options?: Record<string, unknown>;
}

export function formatPersonaImportFileSize(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

export function validatePersonaImportFile(
  file: Pick<File, "name" | "type"> & { size?: number },
): ImportMessageDescriptor | null {
  const isJson = isJsonImportFileName(file.name);
  const isPersonaMarkdown = isPersonaMarkdownImportFileName(file.name);
  if (!isJson && !isPersonaMarkdown) {
    return {
      key: "view.importInvalidExtension",
    } satisfies ImportMessageDescriptor;
  }

  const allowedMimeTypes = isPersonaMarkdown
    ? MARKDOWN_MIME_TYPES
    : JSON_MIME_TYPES;
  if (!allowedMimeTypes.has(file.type)) {
    return {
      key: "view.importInvalidMimeType",
    } satisfies ImportMessageDescriptor;
  }

  if (typeof file.size === "number" && file.size > MAX_PERSONA_IMPORT_BYTES) {
    return {
      key: "view.importTooLarge",
      options: {
        maxSize: formatPersonaImportFileSize(MAX_PERSONA_IMPORT_BYTES),
      },
    } satisfies ImportMessageDescriptor;
  }

  return null;
}

/**
 * The kind a JSON file names when it is one of the app's own exports and not
 * an agent. Such a file used to be read as a persona with its fields missing
 * (or, with those fields added, imported as an agent whatever it called
 * itself); it is refused by name instead.
 */
export function foreignSourceKind(
  fileContents: string,
  fileName: string,
): "skill" | "project" | null {
  if (!isJsonImportFileName(fileName)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fileContents);
  } catch {
    // Not JSON at all: the import itself says so.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }
  if (parsed.type === "skill" || parsed.type === "builtinSkill") {
    return "skill";
  }
  return parsed.type === "project" ? "project" : null;
}

/** An agent the app already has, as far as an import needs to know it. */
export interface ExistingAgent {
  path: string;
  name: string;
  properties?: Record<string, unknown>;
}

/**
 * Whether a character takes no room where a name is shown. A name may not
 * differ from another only in what nobody can see.
 */
function isInvisible(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return (
    code < 0x09 ||
    (code > 0x0d && code < 0x20) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x2064) ||
    code === 0xfeff
  );
}

function agentNameRef(name: string): string {
  return normalizeAgentRef(
    [...name].filter((character) => !isInvisible(character)).join(""),
  );
}

/**
 * The agent that already answers to `displayName`, if there is one: by its
 * own name, by the name of its file, or as the bundled agent it was made
 * from, compared the way the app matches agents by name.
 *
 * The host lists one agent per name and reads the newer file first, so an
 * imported agent named after one the operator already had took its place in
 * every list, under the same name.
 */
export function findAgentNameClash<T extends ExistingAgent>(
  displayName: string,
  agents: readonly T[],
): T | undefined {
  const wanted = agentNameRef(displayName);
  if (!wanted) {
    return undefined;
  }
  return agents.find((agent) =>
    personaAgentRefs({
      id: agent.path,
      displayName: agentNameRef(agent.name),
      sourceProperties: agent.properties,
    }).includes(wanted),
  );
}

/** What was imported, by name. */
export function formatImportSuccessMessage(
  imported: readonly { displayName: string }[],
): ImportMessageDescriptor {
  if (imported.length === 1) {
    return {
      key: "view.imported_one",
      options: { name: imported[0].displayName },
    };
  }

  return {
    key: "view.imported_other",
    options: {
      count: imported.length,
      names: imported.map((agent) => agent.displayName).join(", "),
    },
  };
}

export function formatAgentError(error: unknown, fallback: string): string {
  return formatAcpErrorMessage(error, fallback);
}
