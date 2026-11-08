# Sessions

A session is a single conversation with an agent — what a user casually
calls a "chat." It's the object `flockctl session` and `sessions.json`'s
strings name it as; "chat" is the informal word for the same thing, not a
separate object. A session runs on a harness — `claude-acp`, `codex-acp`,
`grok-acp`, `kimi-acp`, `zai-acp`, `copilot-acp`, or `amp-acp` — chosen per
session; a question about a specific harness's own behavior is out of scope
for this skill (see the Scope section in `SKILL.md`). Within a session, a
user can attach workspaces (folders/repos), tag in skills and agents, and
open artifacts (rendered files) in a side viewer. A session can also be
forked, renamed, moved into a project, or archived.

This is the largest and fastest-changing surface in the app — do not
describe specific composer behavior, artifact viewer capabilities, or
transcript UI from memory. Verify against `src/features/chat/` (particularly
`hooks/useChat*.ts` for session behavior and `ui/ArtifactViewer.tsx` for the
artifact viewer), `src/shared/i18n/locales/en/sessions.json` for session
history/archive/fork/import behavior, or the live UI before answering
anything specific.

## Computer use

A chat can let its agent operate Windows apps in the background — find a
window, read its controls, click, type, scroll — without taking the user's
mouse, keyboard or focus. It is off for every chat until the user turns it on
with the composer's computer switch, and benchmark runs never have it. The
first time, Flock downloads the Cua Driver release it pins and checks its
checksum; the driver's telemetry and update checks are turned off. The change
applies from the chat's next turn, so the switch waits while a turn runs.

Flock gives the agent a short set of window tools and refuses foreground
input, desktop-wide input, and the driver's other tools (scripts, clipboard,
recordings, closing apps). Apps that only accept foreground input — many
Chromium and Electron windows — answer `background_unavailable`; the agent is
told to try another route or ask the user. Several chats with computer use on
share one desktop, so they can still interfere with each other's windows.
Verify specifics against `src-tauri/src/services/computer_use/` before
answering.

## The right rail (files, worktrees, terminal)

A session's right rail is scoped to whatever workspace(s) (folders, repos,
worktrees) are attached to that session — the same attachment concept named
above, not a separate feature. It composes a few distinct pieces: a
workspace list, a changes view (git status/diff for the attached workspace),
an artifacts view (files opened from the session), and a dockable terminal
that can open at a specific path. "Where did my files go" or "what's the
changes tab" questions are almost always about one of these, scoped to the
session's attached workspace(s) — ask which workspace/project the user means
if it's ambiguous. This is one of the most actively-changing parts of the
app; verify specifics against `src/features/chat/ui/ContextPanel.tsx` and
`src/features/terminal/` rather than describing widget behavior from memory.
