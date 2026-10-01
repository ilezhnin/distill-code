import type { SessionNotification } from "@agentclientprotocol/sdk";

export interface HistoryPage {
  events: SessionNotification[];
  olderCursor: number | null;
  highWaterEventId: number;
}

interface HistoryHandler {
  begin(sessionId: string): void;
  accept(sessionId: string, page: HistoryPage): Promise<void>;
  failed(sessionId: string): Promise<void>;
}

let handler: HistoryHandler | undefined;

export function setHistoryHandler(value: HistoryHandler): void {
  handler = value;
}

export function getHistoryHandler(): HistoryHandler | undefined {
  return handler;
}
