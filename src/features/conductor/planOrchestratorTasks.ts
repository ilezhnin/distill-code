const NUMBERED_TASK_PATTERN =
  /(?:^|\n)\s*(?:\d+[).]|[-*])\s+(\S[\s\S]*?)(?=(?:\n\s*(?:\d+[).]|[-*])\s+)|\s*$)/g;

export function planOrchestratorTasks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const tasks: string[] = [];
  for (const match of trimmed.matchAll(NUMBERED_TASK_PATTERN)) {
    const task = match[1]?.trim();
    if (task) tasks.push(task.replace(/\s+/g, " "));
  }

  if (tasks.length >= 2 && tasks.length <= 6) {
    return tasks;
  }

  return [trimmed];
}
