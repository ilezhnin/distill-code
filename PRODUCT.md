# Product

## Purpose

Levocat Flock is a Windows desktop development environment where models from
different providers work as a team. No single model is best at everything, and
a flock does not need one. A conductor breaks a task into waves, gives every
step a class of work, and hands that step to the model that has earned the
class. Small squads take a task apart in parallel, and the steps that depend
on them see every report that came before.

Users connect their own provider accounts, work directly with one agent or
delegate a larger task to the flock, and keep projects, history, memory,
skills, and benchmark evidence in one local place. They can plan, execute, and
review work, compare models and whole workflows on their own tasks, and resume
a project with its context intact.

## Users

Flock is for engineers, designers, and other builders who move between
planning and implementation and already reach for more than one agent
harness. They need clear context, visible progress, and results they can
inspect and use.

Success means users can complete and resume work without reconstructing its
history or losing track of which agent is doing what, and can trust the model
chosen for a step because the choice was measured, not assumed.

## Core experience

- **Direct work and delegation.** Start a conversation with one agent, or let a
  conductor divide the work into waves, delegate each step to an executor, and
  judge the results before the next wave flies.
- **Agents name the work, not the model.** An agent is a plain Markdown file
  whose frontmatter points at a class of work rather than a model. Whichever
  model has earned that class does the job; an explicit pin on a model always
  wins.
- **The lead is earned.** Models and workflows are measured on the user's own
  tasks by quality, execution time, and reported usage and cost. A selection
  rule is fixed before the run and checked on held-out cases; it earns a
  certificate only if the evidence passes, and routing follows certificates
  class by class. Until a class is certified, the user's own fallback order
  decides, and the app records why. Missing measurements are shown as unknown,
  never as a claim.
- **Every bird is visible.** Under each message the user sees who worked on it,
  the conductor, its orchestrators and their subagents, each with a live
  status, and can open any of their chats in a tab beside the current one.
- **Context that lasts.** Projects, history, editable memory, and project
  knowledge carry across sessions. Roles and skills are reusable; role images
  are optional.
- **Local by default.** Chats, settings, and project records stay on the user's
  machine. Users choose the providers their agents work with.

## Personality

Calm, focused, and capable, with enough warmth to make daily use comfortable.
The voice is the same as on [levocat.com](https://www.levocat.com/flock/):
plain, first-hand, a little wry, and never hyped. Respect experienced users
without making the product cryptic for someone getting started.

Flock is not a generic chatbot wrapper, a dark terminal skin, a dashboard
stuffed with metrics, a marketing site wearing product chrome, or a pile of
disconnected settings pages. Avoid decorative AI effects, oversized cards,
vague promises, and screens crowded with metrics or settings. Visuals should
support the work.

## Design principles

- **Make context clear.** Show the active project, agent, model, and relevant
  workspace context where they affect the task.
- **Make collaboration visible.** Users should be able to follow delegated
  work, open an agent's conversation, and inspect its results.
- **Keep the work surface quiet.** Prioritize the conversation, active tools,
  and useful artifacts. Reveal configuration when it is relevant.
- **Show the actual state.** Distinguish progress, completion, failure, and
  unavailable capabilities. Give a clear next action when work cannot proceed.
- **Show evidence honestly.** Present measured results and their limits.
  Missing measurements are unknown; benchmark claims need supporting evidence.
- **Design for continuity.** Preserve context, drafts, history, and navigation
  so users can move between tasks and return without unnecessary setup.

## Accessibility

Use semantic controls, labels for icon-only actions, keyboard navigation,
visible focus, localized text, and reduced-motion support. Keep light and dark
themes readable, never rely on color alone to convey state, and make compact
layouts usable with assistive technology.

## Names

The product name is Levocat Flock; "Flock" is the short form inside a
sentence. Flock grew out of a project called Distill, and the app, its tools,
its identifier, its bundled skills and its default data folder now carry the
Flock name. The names that still say Distill are kept on purpose, for
compatibility with existing data and protocols: the protocol fences, the
persisted keys, each project's `.distill/` folder, the `~/.distill` folder of
an upgraded install and the benchmark sandbox. The
[documentation index](docs/README.md#a-note-on-names) lists them.

For onboarding, see [README.md](README.md). Development guidance lives in
[AGENTS.md](AGENTS.md); required product behavior is defined in
[LAWS/](LAWS/README.md).
