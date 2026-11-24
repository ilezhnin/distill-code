import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { formatAcpErrorMessage } from "@/shared/api/acpErrors";
import { useFileImportZone } from "@/shared/hooks/useFileImportZone";
import {
  exportSkill,
  importSkills,
  isSkillImportFileName,
  readSkillImportRefusal,
  type SkillImportRefusal,
  type SkillInfo,
} from "../api/skills";
import { downloadExport } from "../lib/skillsHelpers";

const MAX_SKILL_IMPORT_BYTES = 10 * 1024 * 1024;

function validateSkillImportFile(
  file: Pick<File, "name" | "type" | "size">,
): string | null {
  return isSkillImportFileName(file.name)
    ? null
    : "view.importDialog.unsupportedFile";
}

/**
 * The message for an import the host refused: which kind the file holds
 * beside the one this screen imports, or whose name it would have taken.
 */
export function skillImportRefusalMessage(refusal: SkillImportRefusal): {
  key: string;
  options?: Record<string, string>;
} {
  if (refusal.reason === "nameTaken") {
    return {
      key: "view.importRefused.nameTaken",
      options: { name: refusal.name, existing: refusal.existing },
    };
  }
  if (refusal.found === "agent" || refusal.found === "project") {
    return { key: `view.importRefused.${refusal.found}` };
  }
  return { key: "view.importRefused.other" };
}

export function useSkillImportExport({
  onImportSuccess,
}: {
  onImportSuccess?: () => void;
} = {}) {
  const { t } = useTranslation(["skills"]);

  const handleExport = async (skill: SkillInfo) => {
    if (skill.readonly) {
      return;
    }

    try {
      const result = await exportSkill(skill.path);
      downloadExport(result.json, result.filename);
      toast.success(t("view.exportedTo", { filename: result.filename }));
    } catch (error) {
      toast.error(formatAcpErrorMessage(error, t("view.exportError")));
    }
  };

  const handleImport = async (fileBytes: Uint8Array, fileName: string) => {
    try {
      const imported = await importSkills(Array.from(fileBytes), fileName);
      toast.success(
        t("view.importSuccess", {
          name: imported.map((skill) => skill.name).join(", "),
        }),
      );
      onImportSuccess?.();
    } catch (error) {
      const refusal = readSkillImportRefusal(error);
      if (refusal) {
        const message = skillImportRefusalMessage(refusal);
        toast.error(t(message.key, message.options));
        return;
      }
      toast.error(formatAcpErrorMessage(error, t("view.importError")));
    }
  };

  const fileImport = useFileImportZone({
    onImportFile: handleImport,
    validateFile: (file) => {
      const errorKey = validateSkillImportFile(file);
      return errorKey ? t(errorKey) : null;
    },
    onImportError: (message) => toast.error(message),
    maxBytes: MAX_SKILL_IMPORT_BYTES,
    fileTooLargeMessage: t("view.importDialog.fileTooLarge"),
  });

  return { ...fileImport, handleExport };
}
