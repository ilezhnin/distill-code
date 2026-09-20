# Proposal: a law for tool calls a finished run left open

**This file is not a law.** It is a proposal for product review, kept apart
from the code change it follows. Delete it once the item below is decided, and
apply the adopted wording to the law file it names.

**No law change is required for the code to be correct.** The code already
behaves as the proposed text says.

Context: a run can end without closing the tool calls it started — the operator
stops it, the bridge dies, or the app itself goes away under the turn (the case
that prompted this: `tauri dev` relaunching the app an agent was editing). The
transcript then holds the call and never its result. Until now such a call
rendered as running for good: reloaded hours later it still showed a pulsing
clock and an elapsed time counting from the original start ("Edit … 4211s"),
which reads as an agent that is working and merely slow. The chat was in fact
idle the whole time.

## 1. LAWS/CHAT.md — Session activity presentation

Proposed addition:

> A chat whose session is not running MUST NOT present a tool call in its
> transcript as waiting or running.

Why this is a law candidate rather than feature policy: it is a boundary on
what the transcript may claim about the session, in the same family as the
existing activity-presentation laws, and it holds whatever the tool card looks
like. Which status such a call is given instead (today `stopped`, shown as
"Stopped") is feature policy and deliberately not part of the wording.

How the code conforms: `settleAbandonedToolCalls`
(`src/features/chat/lib/messageCompletion.ts`) closes every call without a
result when a run settles (`chatStore.settleActiveRun`), when the operator
stops a reply, and at the end of a replay of a session the host lists with no
active run (`sessionActivation.ts`). A result that does arrive late still wins:
the update finds its call by id and overwrites the status.
