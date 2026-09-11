import { useCallback, type RefObject } from "react";
import type { SkillCommandMatch } from "@/features/skills/lib/skillChatPrompt";
import type { ChatAttachmentDraft, MessageChip } from "@/shared/types/messages";
import { submitComposerMessage } from "../lib/submitComposerMessage";
import type { ChatInputSendHandler, ChatSkillDraft } from "../types";

interface UseChatInputSubmitOptions {
  selectedChipsRef: RefObject<MessageChip[]>;
  skillProviderId?: string | null;
  selectedPersonaId?: string | null;
  onSend: ChatInputSendHandler;
  resolveSkillSlashCommand: (
    message: string,
  ) => SkillCommandMatch<ChatSkillDraft> | null;
}

export function useChatInputSubmit({
  selectedChipsRef,
  skillProviderId,
  selectedPersonaId,
  onSend,
  resolveSkillSlashCommand,
}: UseChatInputSubmitOptions) {
  const submitChatInputMessage = useCallback(
    (
      submittedText: string,
      submittedAttachments: ChatAttachmentDraft[],
      submittedSkills: ChatSkillDraft[],
      submitHandler: ChatInputSendHandler = onSend,
    ) =>
      submitComposerMessage({
        text: submittedText,
        attachments: submittedAttachments,
        skills: submittedSkills,
        chips: selectedChipsRef.current,
        skillProviderId,
        selectedPersonaId,
        onSend: submitHandler,
        resolveSkillSlashCommand,
      }),
    [
      onSend,
      resolveSkillSlashCommand,
      selectedChipsRef,
      selectedPersonaId,
      skillProviderId,
    ],
  );

  return { submitChatInputMessage };
}
