import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ChatAutomationIndicator } from "../ChatAutomationIndicator";
import { SessionAutomationBadges } from "@/features/sessions/ui/SessionAutomationBadges";
import { useChatLoopStore } from "@/features/chat-automation/loopStore";
import { useChatGoalStore } from "@/features/chat-automation/goalStore";
import { goalTurnDeliveryId } from "@/features/chat-automation/commands";
import { useChatStore } from "@/features/chat/stores/chatStore";
import { getVisibleSessions } from "@/features/chat/stores/chatSessionStore";
import { useActiveAutomationSessionIds } from "@/features/sessions/hooks/useActiveAutomationSessionIds";
import { createUserMessage } from "@/shared/types/messages";

const id = "fixture";
afterEach(() => {
  cleanup();
  useChatGoalStore.setState({ goals: {} });
  useChatLoopStore.setState({ loops: {} });
});
function mount() {
  return render(
    <>
      <ChatAutomationIndicator sessionId={id} />
      <SessionAutomationBadges
        descriptionId="automation-description"
        sessionId={id}
      />
    </>,
  );
}

it("marks only the current chat, distinguishes its own turn, and renews its cap on resume", () => {
  const store = useChatGoalStore.getState();
  store.start("other", "Unrelated task", 1);
  const view = mount();
  expect(view.container).toHaveTextContent(/^$/);
  act(() => store.start(id, "Review sample", 2));
  expect(screen.getByText("Goal active")).toBeVisible();
  expect(
    screen.getByText(/Waiting for the chat.*0 of 2 turns.*0 tokens.*elapsed/),
  ).toBeVisible();
  const goal = useChatGoalStore.getState().goals[id];
  const message = createUserMessage(goal.objective);
  act(() => {
    useChatStore.getState().addMessage(id, message);
    store.update(id, { pendingMessageId: message.id });
  });
  expect(screen.queryByText(/^Working/)).toBeNull();
  act(() => {
    const automated = createUserMessage(goal.objective);
    automated.metadata = { distillDeliveryId: goalTurnDeliveryId(goal.id, 1) };
    useChatStore.getState().addMessage(id, automated);
    store.update(id, { pendingMessageId: automated.id, turns: 1 });
  });
  expect(screen.getByText(/^Working.*1 of 2 turns/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.getByText(/Paused · At the operator’s request/)).toBeVisible();
  expect(screen.queryByText("Goal active")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Resume" }));
  expect(screen.getByText(/0 of 2 turns/)).toBeVisible();
  act(() => store.reach(id, "Reviewed"));
  expect(screen.getByText(/Goal reached/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect(view.container).toHaveTextContent(/^$/);
});

it("shows each loop's cadence and expiry and controls only the selected loop", () => {
  const store = useChatLoopStore.getState();
  const loop = store.start(id, "Review changes", 60000);
  if (!loop) throw Error("Missing loop");
  store.update(id, loop.id, { nextRunAt: Date.now() + 60000 });
  store.start(id, "Check replies");
  mount();
  const region = screen.getByRole("region", { name: /Review changes/ });
  expect(region).toHaveTextContent(/Next run in.*Every 1m.*Expires/);
  expect(screen.getByText(/Chat chooses the interval/)).toBeVisible();
  act(() => store.update(id, loop.id, { nextRunAt: Number.MAX_SAFE_INTEGER }));
  expect(region).toHaveTextContent("No further run before expiry");
  expect(region).not.toHaveTextContent("Next run in");
  fireEvent.click(within(region).getByRole("button", { name: "Pause" }));
  expect(region).not.toHaveTextContent("Next run in");
  expect(screen.getByText("Loop active")).toBeVisible();
  fireEvent.click(within(region).getByRole("button", { name: "Resume" }));
  expect(region).toHaveTextContent("Waiting for the chat");
  fireEvent.click(within(region).getByRole("button", { name: "Stop" }));
  expect(screen.queryByRole("region", { name: /Review changes/ })).toBeNull();
  expect(screen.getByRole("region", { name: /Check replies/ })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Pause" }));
  expect(screen.queryByText("Loop active")).toBeNull();
});

it("keeps active chats with no saved messages in the list after hydration", () => {
  const sessions = ["goal", "loop", "empty"].map((id) => ({
    id,
    messageCount: 0,
  }));
  const { result } = renderHook(() =>
    getVisibleSessions(sessions, {}, useActiveAutomationSessionIds()).map(
      (row) => row.id,
    ),
  );
  expect(result.current).toEqual([]);
  act(() => {
    useChatGoalStore.getState().start("goal", "Work", 2);
    useChatLoopStore.getState().start("loop", "Check");
  });
  expect(result.current).toEqual(["goal", "loop"]);
  act(() => useChatGoalStore.getState().pause("goal"));
  expect(result.current).toEqual(["loop"]);
});
