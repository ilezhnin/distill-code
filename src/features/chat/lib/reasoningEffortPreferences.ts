import { getClient } from "@/shared/api/acpConnection";

export const REASONING_EFFORT_PREFERENCE_KEY = "thinkingEffort";

export async function saveDefaultReasoningEffort(value: string): Promise<void> {
  const client = await getClient();
  await client.host.preferencesSave({
    values: [{ key: REASONING_EFFORT_PREFERENCE_KEY, value }],
  });
}
