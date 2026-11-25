import type { SkillCommandMatch } from "@/features/skills/lib/skillChatPrompt";
import { isPromiseLike } from "@/shared/lib/isPromiseLike";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";
import type { ChatInputSendHandler, ChatSkillDraft } from "../types";
import { buildSkillSendPayload } from "./skillSendPayload";

interface SubmitComposerMessageOptions {
  text: string;
  attachments: ChatAttachmentDraft[];
  skills: ChatSkillDraft[];
  chips?: MessageChip[];
  skillProviderId?: string | null;
  selectedPersonaId?: string | null;
  onSend: ChatInputSendHandler;
  resolveSkillSlashCommand: (
    message: string,
  ) => SkillCommandMatch<ChatSkillDraft> | null;
}

export async function submitComposerMessage({
  text,
  attachments,
  skills,
  chips = [],
  skillProviderId,
  selectedPersonaId,
  onSend,
  resolveSkillSlashCommand,
}: SubmitComposerMessageOptions) {
  const slashSkillCommand =
    skills.length === 0 ? resolveSkillSlashCommand(text) : null;
  const { messageText, sendOptions } = buildSkillSendPayload(
    text,
    skills,
    slashSkillCommand,
    { providerId: skillProviderId },
  );
  const mergedChips =
    sendOptions?.chips && sendOptions.chips.length > 0
      ? [...chips, ...sendOptions.chips]
      : chips;
  // Typed here, so it is the operator's: the one origin besides their own
  // terminal whose /goal or /loop runs as the command (`automationCommand`).
  const mergedSendOptions = {
    ...sendOptions,
    ...(mergedChips.length > 0 ? { chips: mergedChips } : {}),
    commandOrigin: "composer" as const,
  };
  const submittedText = sendOptions ? messageText : messageText.trim();
  const submittedAttachments = attachments.length > 0 ? attachments : undefined;
  const sendResult = onSend(
    submittedText,
    selectedPersonaId,
    submittedAttachments,
    mergedSendOptions,
  );
  const accepted = isPromiseLike<boolean>(sendResult)
    ? await sendResult
    : sendResult;
  return accepted !== false;
}
